# Deploy highly available Infrastructure on EC2 with Docker Compose

AWS EC2 features "autoscaling groups", a way to setup EC2 to spawn up instances as necessary.

We can setup an AWS elastic load balancer in front of the group to distribute traffic. Each EC2 instance should be running the same docker images. We can use Traefik to automatically discover containers to serve HTTP traffic from (or not... the same setup can be used to run, say, background jobs).

We'll use docker-compose to spawn up a group of docker containers. The `docker-compose.yml` file will be copied to EC2 servers from an S3 bucket.

This example uses an ASG of 1 instance. AWS supports setting up alarms and scaling out on high CPU usage and other metrics. CDK allows setting this up and can be easily added to the deploy script if required. Also, while it is possible to deploy to multiple regions with the same script, here we just do it to a single region, in multiple availability zones.

*NOTE*: having an ASG of 1 instance is still useful as AWS can restart the instance if it dies, for whatever reason, even if you manually stop it!

## Requirements:

* A running [AWS CLI app](https://docs.aws.amazon.com/cli/).
* A bootstrapped [CDK installation](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html#getting_started_bootstrap) (see also (CDK Workshop)[https://cdkworkshop.com/]).
* Docker.

## Bootstrap

The deploy script needs an S3 bucket and ECR repo to work. This can be done from the amazon console, or by running the following commands.

NOTE: we don't create these resources at deploy time since the script assumes these already exist. Also CDK owns everything it creates, so it is nice to keep these two resources human-controlled.

1. Configure env variables. For instance, with an .env file like this:
```sh
SINFRA_STACK_NAME=myapp-infra
SINFRA_S3_BUCKET=myapp-deploy-config
SINFRA_ECR_REPO=myapp-deploy-repo
```

Run:
```sh
$ source .env
```

2. Create an s3 bucket.
```sh
$ aws s3 mb s3://$SINFRA_S3_BUCKET
```

3. Copy a docker compose file to the bucket. Here we use an example one.
```sh
$ aws s3 cp assets/example/docker-compose.yml s3://$SINFRA_S3_BUCKET/docker-compose.yml
```

4. Create an ECR repository.
```sh
$ aws ecr create-repository --repository-name $SINFRA_ECR_REPO --region $(aws-scripts/ec2-region)
```

5. Run the CDK script to create the infrastructure (the script requires the previous env vars).
```sh
$ cd update-infra && npm run cdk deploy 
```

4. Open load-balancer url from the CDK output, you should see the application running.

## How to SSH into the EC2 instance/s

We can connect to the machine/s without opening port 22, through AWS Systems Manager agent. See https://cloudonaut.io/connect-to-your-ec2-instance-using-ssh-the-modern-way/ for more information.

Add the following configuration in your local `.ssh/config`, then connect with `ssh i-*`, where i-* is the instance id:
```sh
# SSH AWS instance over Session Manager.
host i-*
  IdentityFile ~/.ssh/id_ed25519
  User ec2-user
  ProxyCommand sh -c "aws ec2-instance-connect send-ssh-public-key --instance-id %h --instance-os-user %r --ssh-public-key 'file://~/.ssh/id_ed25519.pub' --availability-zone '$(aws ec2 describe-instances --instance-ids %h --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)' && aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p'"
```
*NOTE*: make sure your are using your own key pair, i'm using `id_ed25519` and `id_ed25519.pub` here.

You can retrieve a list of all EC2 instances on autoscale groups with:

```sh
$ aws autoscaling describe-auto-scaling-instances --instance-ids
{
    "AutoScalingInstances": [ { "InstanceId": "i-123456789abcdefgh", ... }, ... ]
}
```

Now if I ssh into the instance name, the proxy command is triggered:
```sh
$ ssh i-123456789abcdefgh # Profit :-)
```

## Rolling deploys

To perform rolling deploys, we need to update the docker-compose.yml file, upload to S3, then ask each server in the autoscaling group to rollout the new container. The ECR repo comes handy here: we can push the built container there, and point to it from the docker-compose.yml file. Every EC2 instance should be authorized to pull from it.

## Adjusting the infrastructure.

CDK deploys uses CloudFormation, which is declarative. To perform infrastructure changes, we can simply modify the `update-infra/deploy.ts` script and re-deploy (`npm run cdk deploy`). Most of the times these changes can be performed in place, although in my experience sometimes is necessary to recreate the infra when we change things like VPC configurations in a way that CloudFormation can't fix. But things like changing number or type of instances just work.
