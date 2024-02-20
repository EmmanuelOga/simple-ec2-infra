# Running Docker Compose with SystemD

Scripts taken from https://gist.github.com/mosquito/b23e1c1e5723a7fd9e6568e5cf91180f

NOTE: for JournalD support, add the following line to the /etc/docker/daemon.json:

{
    ...
    "log-driver": "journald",
    ...
}

And restart your docker service.