
### Installation

All bots can be installed as systemd services using a single command from git root:

```
sudo ./scripts/install.sh
```

To customize the environment of all bots, place a bash script at `./env.sh`
Each bot has it's own env file at `env/$asset.sh`.

For convenience a small wrapper around systemctl is available that allows to quickly start & stop all services

```
./scripts/ctl.sh [start|stop]
```

The output of each bot can be inspected using journalctl:

```
journalctl -f -u raven-taker-sol.service
```
