#!/usr/bin/env bash
#
# Deploy PodJobs and PodToken to Monad testnet, and write the addresses back into .env.
#
# Everything it needs is in .env, which is gitignored: the deployer key that pays, the validator
# address the contracts answer to, and the RPC. It refuses to run rather than guess at any of them.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$here/.env"
[ -f "$env_file" ] || { echo "no .env at $env_file"; exit 1; }

set -a; . "$env_file"; set +a
: "${POD_DEPLOYER_KEY:?POD_DEPLOYER_KEY is not set}"
: "${POD_VALIDATOR_ADDRESS:?POD_VALIDATOR_ADDRESS is not set}"
: "${MONAD_TESTNET_RPC:?MONAD_TESTNET_RPC is not set}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

balance=$(cast balance "$POD_DEPLOYER_ADDRESS" --rpc-url "$MONAD_TESTNET_RPC")
if [ "$balance" = "0" ]; then
  echo "the deployer $POD_DEPLOYER_ADDRESS has no MON. Fund it from the faucet first."
  exit 1
fi
echo "deployer $POD_DEPLOYER_ADDRESS has $(cast to-unit "$balance" ether) MON"

cd "$here/contracts"
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$MONAD_TESTNET_RPC" \
  --broadcast \
  --slow \
  | tee /tmp/pod-deploy.log

jobs_address=$(grep -Eo 'jobs: contract PodJobs 0x[0-9a-fA-F]{40}' /tmp/pod-deploy.log | grep -Eo '0x[0-9a-fA-F]{40}' | tail -1)
token_address=$(grep -Eo 'token: contract PodToken 0x[0-9a-fA-F]{40}' /tmp/pod-deploy.log | grep -Eo '0x[0-9a-fA-F]{40}' | tail -1)
[ -n "$jobs_address" ] && [ -n "$token_address" ] || { echo "could not read the addresses out of the deployment"; exit 1; }

# write them back, so the runner and the README are reading the same deployment
python3 - "$env_file" "$jobs_address" "$token_address" <<'PY'
import pathlib, sys
path, jobs, token = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = []
for line in path.read_text().splitlines():
    if line.startswith("POD_JOBS_ADDRESS="): line = f"POD_JOBS_ADDRESS={jobs}"
    elif line.startswith("POD_TOKEN_ADDRESS="): line = f"POD_TOKEN_ADDRESS={token}"
    lines.append(line)
path.write_text("\n".join(lines) + "\n")
PY

echo
echo "PodJobs  $jobs_address"
echo "PodToken $token_address"
echo "written into .env"
