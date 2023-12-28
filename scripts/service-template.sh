#!/bin/sh

cat  << EOF
[Unit]
Description=raven taker $1
After=network.target

[Service]
User=max
ExecStart=$PWD/scripts/raven-taker.sh $1
WorkingDirectory=$PWD
Restart=on-failure
RestartSec=60

[Install]
WantedBy=multi-user.target
EOF