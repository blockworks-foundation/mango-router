#!/bin/bash

for config in ./env/*.sh
do
	asset=$(basename "$config" .sh)
	[[ $asset == "_shared" ]] && continue
	./scripts/service-template.sh $asset >/lib/systemd/system/raven-taker-$asset.service
	systemctl enable raven-taker-$asset
done
