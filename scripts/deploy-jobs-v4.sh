#!/usr/bin/env bash
#
# The third switch-over: deploy the contract on which the lead names who is paid, beside the one on
# which the poster has the last word, and point .env at it.
#
# It deploys PodJobsV4 only. The title contract stays as it is, since titles are numbered by the job's
# number and the new contract continues the numbering of the one it replaces. So that no job there is
# left half way, it refuses to run while any of them is still being prepared, open, worked or waiting
# for its poster's answer: nothing will finish such a job once the server and the worker have moved
# on. It reads that contract's next number at the moment of deploying, after posting there has closed.
# Everything it needs is in .env, which is gitignored; it refuses to run rather than guess, and it
# prints no key.
#
# POD_ENV_FILE names another env file, for a throwaway deployment. POD_ANSWER_SECONDS is how long a
# poster has to accept or refuse a delivery. After it: POD_JOBS_ADDRESS names the new contract,
# POD_THIRD_JOBS_ADDRESS the one it replaced, and POD_SECOND_JOBS_ADDRESS and POD_OLD_JOBS_ADDRESS the
# two before that, as before. Restart the server and the worker.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${POD_ENV_FILE:-$here/.env}"
[ -f "$env_file" ] || { echo "no .env at $env_file"; exit 1; }

set -a; . "$env_file"; set +a
: "${POD_DEPLOYER_KEY:?POD_DEPLOYER_KEY is not set}"
: "${POD_DEPLOYER_ADDRESS:?POD_DEPLOYER_ADDRESS is not set}"
: "${POD_VALIDATOR_ADDRESS:?POD_VALIDATOR_ADDRESS is not set}"
: "${POD_WRITER_ADDRESS:?POD_WRITER_ADDRESS is not set: the key the server writes checks with, never the validator}"
: "${POD_WRITING_PRICE_WEI:?POD_WRITING_PRICE_WEI is not set: what one writing of the checks of a job costs}"
: "${POD_PAYOUT_GAS:?POD_PAYOUT_GAS is not set: the gas sent with every payment}"
: "${POD_ANSWER_SECONDS:?POD_ANSWER_SECONDS is not set: how long a poster has to accept or refuse a delivery, such as 259200 for three days}"
: "${POD_JOBS_ADDRESS:?POD_JOBS_ADDRESS is not set: the contract on which the poster has the last word, which this one continues}"
: "${POD_SECOND_JOBS_ADDRESS:?POD_SECOND_JOBS_ADDRESS is not set: the second switch-over has to have been made}"
: "${POD_OLD_JOBS_ADDRESS:?POD_OLD_JOBS_ADDRESS is not set: the first switch-over has to have been made}"
: "${MONAD_TESTNET_RPC:?MONAD_TESTNET_RPC is not set}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

if [ -n "${POD_THIRD_JOBS_ADDRESS:-}" ]; then
  echo "POD_THIRD_JOBS_ADDRESS is set already: this switch-over has been made, to $POD_JOBS_ADDRESS"
  exit 1
fi
third="$POD_JOBS_ADDRESS"
rpc="$MONAD_TESTNET_RPC"

# a number read from a contract: cast prints a large one twice over, as "259200 [2.592e5]"
number() { cast call "$1" "$2" --rpc-url "$rpc" | awk '{ print $1 }'; }

# the contract being replaced is one on which the poster has the last word, and the lead does not yet name who is paid
cast call "$third" "answerTime()(uint64)" --rpc-url "$rpc" >/dev/null 2>&1 \
  || { echo "POD_JOBS_ADDRESS names $third, on which the poster does not have the last word: there is nothing for this contract to replace"; exit 1; }
if cast call "$third" "concluded(uint256)(bool)" 0 --rpc-url "$rpc" >/dev/null 2>&1; then
  echo "POD_JOBS_ADDRESS names $third, on which the lead already names who is paid"
  exit 1
fi

# every job there is finished: settled or refunded (state 2 or 3), none preparing, open, worked or delivered
first=$(number "$POD_SECOND_JOBS_ADDRESS" "nextJobId()(uint256)")
next=$(number "$third" "nextJobId()(uint256)")
unfinished=""
for ((id = first; id < next; id++)); do
  state=$(cast call "$third" "jobs(uint256)(address,uint256,bytes32,uint64,uint8,bytes32,uint8,uint64)" "$id" --rpc-url "$rpc" | sed -n 5p)
  if [ "$state" != "2" ] && [ "$state" != "3" ]; then unfinished="$unfinished $id"; fi
done
if [ -n "$unfinished" ]; then
  echo "jobs not finished on the contract being replaced:$unfinished."
  echo "A job still being prepared is taken back by its poster; one open or worked is delivered, or closed once its window ends; one delivered is answered by its poster, or settled once their time to answer is up. Nothing finishes them after the switch."
  exit 1
fi
echo "every one of the $((next - first)) jobs on the contract being replaced is finished; the new contract starts at $next"

balance=$(cast balance "$POD_DEPLOYER_ADDRESS" --rpc-url "$rpc")
[ "$balance" != "0" ] || { echo "the deployer $POD_DEPLOYER_ADDRESS has no MON"; exit 1; }
echo "deployer $POD_DEPLOYER_ADDRESS has $(cast to-unit "$balance" ether) MON"

cd "$here/contracts"
POD_THIRD_JOBS_ADDRESS="$third" forge script script/DeployJobsV4.s.sol:DeployJobsV4 \
  --rpc-url "$rpc" \
  --broadcast \
  --slow \
  | tee /tmp/pod-deploy-v4.log

new=$(grep -Eo 'contract PodJobsV4 0x[0-9a-fA-F]{40}' /tmp/pod-deploy-v4.log | grep -Eo '0x[0-9a-fA-F]{40}' | tail -1)
[ -n "$new" ] || { echo "could not read the new contract's address out of the deployment"; exit 1; }
# it is deployed by now, so a check that fails names it: .env is left as it was, and nothing is posted there
[ "$(number "$new" "nextJobId()(uint256)")" = "$next" ] || { echo "the new contract $new does not start at $next; .env is unchanged"; exit 1; }
[ "$(number "$new" "answerTime()(uint64)")" = "$POD_ANSWER_SECONDS" ] || { echo "the new contract $new does not give a poster $POD_ANSWER_SECONDS seconds to answer; .env is unchanged"; exit 1; }
cast call "$new" "concluded(uint256)(bool)" "$next" --rpc-url "$rpc" >/dev/null 2>&1 \
  || { echo "the new contract $new is not one on which the lead names who is paid; .env is unchanged"; exit 1; }

# write them back: the jobs setting is the new contract, and the one it replaced is named as the third
python3 - "$env_file" "$new" "$third" <<'PY'
import pathlib, sys
path, new, third = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = [f"POD_JOBS_ADDRESS={new}" if line.startswith("POD_JOBS_ADDRESS=") else line for line in path.read_text().splitlines()]
lines.append(f"POD_THIRD_JOBS_ADDRESS={third}")
path.write_text("\n".join(lines) + "\n")
PY

echo
echo "PodJobsV4 $new, starting at job $next: the lead names who is paid, the poster has the last word with $POD_ANSWER_SECONDS seconds to answer, and no seat can hold work back: a review is $(number "$new" "REVIEW_SHARE_PERCENT()(uint8)")% of a job's window"
echo "PodJobsV3 $third, read, posted to no more"
echo "written into .env; set the same four addresses where the server and the worker run, and restart both"
