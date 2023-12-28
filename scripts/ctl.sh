#!/bin/bash

for config in ./env/*.sh
do
	asset=$(basename "$config" .sh)
	systemctl $1 raven-taker-$asset
done