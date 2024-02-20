#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import { aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import path = require('path');

export interface SimpleInfraProps {
  readonly s3BucketName: string;
  readonly ecrRepoName: string;
}

export class SimpleInfra extends Construct {
  constructor(scope: Construct, id: string, props: SimpleInfraProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'vpc', {
      maxAzs: 3,

      // Instead of using Gateways, we can put the instances in a public subnet.
      // This is "less secure" but cheaper.
      // To compensate, we can use NACL and Security Groups to restrict traffic.
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public-subnet',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Don't go through NAT gateway for S3 traffic.
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3
    });

    const role = new iam.Role(this, 'role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    const bucket = s3.Bucket.fromBucketName(this, 'bucket', props.s3BucketName);
    bucket.grantRead(role);

    const repository = ecr.Repository.fromRepositoryName(this, 'ecr-repo', props.ecrRepoName);
    repository.grantRead(role);
    repository.grantPull(role);

    const securityGroup = new ec2.SecurityGroup(this, 'sec-group', {
      vpc: vpc,
    });

    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic from anywhere');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS traffic from anywhere');

    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'asg', {
      vpc,
      role,
      securityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      ssmSessionPermissions: true,

      instanceType: new ec2.InstanceType('t4g.nano'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),

      // Cluster size.
      // desiredCapacity is not needed, as it defaults to minCapacity.
      // Also when redeploying, having it causes the ASG to readjust the capacity.
      minCapacity: 2,
      maxCapacity: 3,

      // How long to CloudFormation wait for the signals to be completed.
      signals: autoscaling.Signals.waitForAll({
        timeout: cdk.Duration.minutes(5),
      }),
    });

    // Install docker-compose, which is not available in the Amazon Linux 2 repositories.
    // https://docs.docker.com/compose/install/linux/#install-the-plugin-manually
    const composeInstallPath = '/usr/local/lib/docker/cli-plugins/';

    // Instead of userData, use cloud formation helper functions to configure the instance.
    // The userData will be filled by CDK to run the CloudFormationInit helper functions.
    // This enables nice features like logging and error handling, and waiting for services to start.
    const init = ec2.CloudFormationInit.fromElements(
      // Install any new security updates available.
      ec2.InitCommand.shellCommand('dnf -y --security update'),

      // Utils to log in to the ECR and pull.
      ec2.InitFile.fromFileInline('/usr/local/bin/ec2-region', path.join(__dirname, '/../aws-scripts/ec2-region'), { mode: '000750', group: 'docker' }),
      ec2.InitFile.fromFileInline('/usr/local/bin/ec2-account-id', path.join(__dirname, '../aws-scripts/ec2-account-id'), { mode: '000750', group: 'docker' }),
      ec2.InitFile.fromFileInline('/usr/local/bin/docker-auth-ecr', path.join(__dirname, '../aws-scripts/docker-auth-ecr'), { mode: '000750', group: 'docker' }),

      // Install and start Docker, and log in to ECR in case we need to pull from there.
      ec2.InitPackage.yum('docker'),
      ec2.InitUser.fromName('ec2-user', { groups: ['docker'] }),
      ec2.InitService.enable('docker', { enabled: true, ensureRunning: true, serviceManager: ec2.ServiceManager.SYSTEMD }),
      ec2.InitCommand.shellCommand('/usr/local/bin/docker-auth-ecr'),

      // Install Docker Compose.
      ec2.InitCommand.shellCommand('mkdir -p ' + composeInstallPath),
      ec2.InitCommand.shellCommand('curl -L https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m) -o ' + composeInstallPath + 'docker-compose'),
      ec2.InitCommand.shellCommand('chmod +x ' + composeInstallPath + 'docker-compose'),

      // Instal Docker Rollout plugin (used to manually rollout a docker-compose.yml after changing it).
      ec2.InitFile.fromFileInline(path.join(composeInstallPath, 'docker-rollout'), path.join(__dirname, '/../vendor/docker-rollout/docker-rollout'), { mode: '000750', group: 'docker' }),
      ec2.InitFile.fromFileInline(path.join(composeInstallPath, 'docker-rollout-readme.md'), path.join(__dirname, '/../vendor/docker-rollout/README.md')),
      ec2.InitFile.fromFileInline(path.join(composeInstallPath, 'docker-rollout-license'), path.join(__dirname, '/../vendor/docker-rollout/LICENSE')),

      // Some utils to manage Docker and Docker Compose through SystemD.
      // From: https://gist.github.com/mosquito/b23e1c1e5723a7fd9e6568e5cf91180f
      ec2.InitFile.fromFileInline('/etc/systemd/system/docker-cleanup.timer', path.join(__dirname, '/../assets/systemd/docker-cleanup.timer')),
      ec2.InitFile.fromFileInline('/etc/systemd/system/docker-cleanup.service', path.join(__dirname, '../assets/systemd/docker-cleanup.service')),
      ec2.InitFile.fromFileInline('/etc/systemd/system/docker-compose@.service', path.join(__dirname, '../assets/systemd/docker-compose@.service')),
      ec2.InitService.enable('docker-cleanup.timer', { enabled: true, ensureRunning: true, serviceManager: ec2.ServiceManager.SYSTEMD }),

      // Copy the initial compose file and start Docker Compose.
      ec2.InitFile.fromS3Object('/home/ec2-user/app/docker-compose.yml', bucket, 'docker-compose.yml', { owner: 'ec2-user', group: 'docker' }),
      ec2.InitCommand.shellCommand('chown -R ec2-user /home/ec2-user/app'),
      ec2.InitService.enable('docker-compose@app', { enabled: true, ensureRunning: true, serviceManager: ec2.ServiceManager.SYSTEMD }),

      // Setup a fancy prompt for all users.
      ec2.InitCommand.shellCommand('curl -s https://ohmyposh.dev/install.sh | bash -s'),
      ec2.InitFile.fromString('/etc/profile.d/prompt.sh', 'eval "$(oh-my-posh init bash)"'),
    );

    autoScalingGroup.applyCloudFormationInit(init, {
      printLog: true,
      ignoreFailures: true,
    });

    // Load balancer.

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, `load-balancer`, {
      vpc,
      internetFacing: true
    });

    // const httpsListener = loadBalancer.addListener('ALBListenerHttps', {
    //   certificates: elbv2.ListenerCertificate.fromArn("Get from AWS  console .. "),
    //   protocol: elbv2.ApplicationProtocol.HTTPS,
    //   port: 443,
    //   sslPolicy: elbv2.SslPolicy.TLS12
    // })

    const httpListener = loadBalancer.addListener('lb-port-80', {
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 80,
    });

    httpListener.addTargets('lb-to-asg-port-80', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [autoScalingGroup],
      healthCheck: {
        path: "/",
        port: '80',
        healthyHttpCodes: '200-299',
      }
    });

    // Attach a WAFv2 WebACL to the load balancer.
    // https://aws.amazon.com/blogs/devops/easily-protect-your-aws-cdk-defined-infrastructure-with-aws-wafv2/
    const cfnWebACL = new wafv2.CfnWebACL(this,
      'cdk-web-acl', {
      name: 'cdk-web-acl',
      defaultAction: {
        allow: {}
      },
      scope: 'REGIONAL',
      visibilityConfig: {
        metricName: 'wafv2-cdk-metric',
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
      },
      rules: [{
        name: 'CRSRule',
        priority: 0,
        statement: {
          managedRuleGroupStatement: {
            name: 'AWSManagedRulesCommonRuleSet',
            vendorName: 'AWS'
          }
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'wafv2-cdk-metric',
          sampledRequestsEnabled: true,
        },
        overrideAction: { none: {} },
      }]
    });

    const cfnWebACLAssociation = new wafv2.CfnWebACLAssociation(this, 'wafv2-for-load-balancer', {
      webAclArn: cfnWebACL.attrArn,
      resourceArn: loadBalancer.loadBalancerArn,
    });

    // Outputs.

    new cdk.CfnOutput(this, 'repository-url', {
      value: repository.repositoryUri,
    });

    new cdk.CfnOutput(this, 'load-balancer-url', {
      value: loadBalancer.loadBalancerDnsName,
    });
  }
}

export class DeployerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new SimpleInfra(this, 'SimpleInfra', {
      s3BucketName: s3BucketName(),
      ecrRepoName: ecrRepoName(),
    });
  }
}

////////////////////////////////////////////////////////////////////////////////// 
// Read input, start Script.
////////////////////////////////////////////////////////////////////////////////// 

function stackName(): string {
  const value = process.env.SINFRA_STACK_NAME || '';
  if (value === '') {
    throw new Error('SIMPLE_INFRA_STACK_NAME env var missing: please provide a stack name.');
  }
  return value;
}

function s3BucketName(): string {
  const value: string = process.env.SINFRA_S3_BUCKET || '';
  if (value === '') {
    throw new Error('SIMPLE_INFRA_S3_BUCKET env var missing: the S3 bucket for `docker-compose.yml`.');
  }
  return value;
}

function ecrRepoName(): string {
  const value: string = process.env.SINFRA_ECR_REPO || '';
  if (value === '') {
    throw new Error('SIMPLE_INFRA_ECR_REPO env var missing: the ECR name of the private docker repo.');
  }
  return value;
}

const app = new cdk.App();
new DeployerStack(app, stackName(), {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});