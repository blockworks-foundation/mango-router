#!/bin/bash
source ~/.nvm/nvm.sh
source env.sh
source env/$1.sh
yarn ts-node src/taker.ts