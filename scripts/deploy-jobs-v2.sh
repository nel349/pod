#!/usr/bin/env bash
#
# The switch-over: deploy the contract that prepares jobs beside the first one, and point .env at it.
#
# It deploys PodJobsV2 only. The title contract stays as it is, since titles are numbered by the job's
# number and the new contract continues the old one's numbering (G1). So that no job on the first
# contract is left half way, it refuses to run while any of them is still open or being worked; and it
# reads the first contract's next number at the moment of deploying, after posting there has closed
# (R7). Everything it needs is in .env, which is gitignored; it refuses to run rather than guess.
#
# POD_ENV_FILE names another env file, for a throwaway deployment. After it: POD_JOBS_ADDRESS names the new contract, POD_OLD_JOBS_ADDRESS the first one, and the server
# needs POD_WRITER_KEY, the key whose address is POD_WRITER_ADDRESS. Restart the server and the worker.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${POD_ENV_FILE:-$here/.env}"
[ -f "$env_file" ] || { echo "no .env at $env_file"; exit 1; }

set -a; . "$env_file"; set +a
: "${POD_DEPLOYER_KEY:?POD_DEPLOYER_KEY is not set}"
: "${POD_DEPLOYER_ADDRESS:?POD_DEPLOYER_ADDRESS is not set}"
: "${POD_VALIDATOR_ADDRESS:?POD_VALIDATOR_ADDRESS is not set}"
: "${POD_WRITER_ADDRESS:?POD_WRITER_ADDRESS is not set: the key the server writes checks with, never the validator}"
: "${POD_WRITER_KEY:?POD_WRITER_KEY is not set: the server signs written checks with it}"
: "${POD_WRITING_PRICE_WEI:?POD_WRITING_PRICE_WEI is not set: what one writing of the checks of a job costs}"
: "${POD_PAYOUT_GAS:?POD_PAYOUT_GAS is not set: the gas sent with every payment, tried with a proxy wallet first}"
: "${POD_JOBS_ADDRESS:?POD_JOBS_ADDRESS is not set: the first contract, which this one continues}"
: "${MONAD_TESTNET_RPC:?MONAD_TESTNET_RPC is not set}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

if [ -n "${POD_OLD_JOBS_ADDRESS:-}" ]; then
  echo "POD_OLD_JOBS_ADDRESS is set already: the switch-over has been made, to $POD_JOBS_ADDRESS"
  exit 1
fi
old="$POD_JOBS_ADDRESS"
rpc="$MONAD_TESTNET_RPC"

lower() { echo "$1" | tr 'A-F' 'a-f'; }
# the writer's key and address are one key, and not the validator's
[ "$(lower "$(cast wallet address --private-key "$POD_WRITER_KEY")")" = "$(lower "$POD_WRITER_ADDRESS")" ] \
  || { echo "POD_WRITER_KEY is not the key for POD_WRITER_ADDRESS"; exit 1; }
[ "$(lower "$POD_WRITER_ADDRESS")" != "$(lower "$POD_VALIDATOR_ADDRESS")" ] \
  || { echo "the writer is the validator: it has to be a key of its own"; exit 1; }

# every job on the first contract is finished: settled or refunded (state 2 or 3), none open or worked
next=$(cast call "$old" "nextJobId()(uint256)" --rpc-url "$rpc")
unfinished=""
for ((id = 1; id < next; id++)); do
  state=$(cast call "$old" "jobs(uint256)(address,uint256,bytes32,uint64,uint8,bytes32,uint8)" "$id" --rpc-url "$rpc" | sed -n 5p)
  if [ "$state" != "2" ] && [ "$state" != "3" ]; then unfinished="$unfinished $id"; fi
done
if [ -n "$unfinished" ]; then
  echo "jobs still running on the first contract:$unfinished. Settle or refund them before switching."
  exit 1
fi
echo "every one of the $((next - 1)) jobs on the first contract is finished; the new contract starts at $next"

for who in "deployer $POD_DEPLOYER_ADDRESS" "writer $POD_WRITER_ADDRESS"; do
  set -- $who
  balance=$(cast balance "$2" --rpc-url "$rpc")
  [ "$balance" != "0" ] || { echo "the $1 $2 has no MON. Fund it first: the writer pays for every writing it reserves, keeps or releases."; exit 1; }
  echo "$1 $2 has $(cast to-unit "$balance" ether) MON"
done

cd "$here/contracts"
POD_OLD_JOBS_ADDRESS="$old" forge script script/DeployJobsV2.s.sol:DeployJobsV2 \
  --rpc-url "$rpc" \
  --broadcast \
  --slow \
  | tee /tmp/pod-deploy-v2.log

new=$(grep -Eo 'contract PodJobsV2 0x[0-9a-fA-F]{40}' /tmp/pod-deploy-v2.log | grep -Eo '0x[0-9a-fA-F]{40}' | tail -1)
[ -n "$new" ] || { echo "could not read the new contract's address out of the deployment"; exit 1; }
[ "$(cast call "$new" "nextJobId()(uint256)" --rpc-url "$rpc")" = "$next" ] || { echo "the new contract does not start at $next"; exit 1; }

# write them back: the jobs setting is the new contract, the old setting the first one
python3 - "$env_file" "$new" "$old" <<'PY'
import pathlib, sys
path, new, old = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = [f"POD_JOBS_ADDRESS={new}" if line.startswith("POD_JOBS_ADDRESS=") else line for line in path.read_text().splitlines()]
lines.append(f"POD_OLD_JOBS_ADDRESS={old}")
path.write_text("\n".join(lines) + "\n")
PY

echo
echo "PodJobsV2 $new, starting at job $next"
echo "PodJobs   $old, read and graded, posted to no more"
echo "written into .env; restart the server and the worker"
