#!/bin/bash
# Compila o cofre (Pinocchio) e roda os testes de seguranca numa rede Solana local, que e desligada no fim.
# Uso: bash scripts/testar.sh (precisa do Solana 2.1.21 e do Rust instalados)
#   Ataque aleatorio: TESTES=tests/fuzz.ts PASSOS=400 SEMENTE=7 bash scripts/testar.sh
set -e
export PATH="$HOME/.cargo/bin:$HOME/solana-cli/solana-release/bin:$PATH"
cd "$(dirname "$0")/.."

cargo build-sbf --manifest-path programs/cofre/Cargo.toml
LEDGER=$(mktemp -d)
# Publicado como atualizavel, com a carteira local como autoridade (o inicializar exige isso, igual a devnet)
solana-test-validator --ledger "$LEDGER" --reset --quiet --bind-address 127.0.0.1 --rpc-port 8899 \
  --upgradeable-program HMPj2NkqVJJUpjg4TxMjCfDCc8NLSUV5VN32DRzzy25n target/deploy/cofre.so ~/.config/solana/id.json &
VALIDADOR=$!
# Desliga a rede local no fim sem trocar o resultado dos testes (o "wait" devolve 143 = processo encerrado)
trap 'r=$?; kill $VALIDADOR 2>/dev/null; wait $VALIDADOR 2>/dev/null || true; rm -rf "$LEDGER"; exit $r' EXIT
for i in $(seq 1 60); do solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 && break; sleep 2; done

# Sem o "strip-types" do Node: quem traduz o TypeScript dos testes e o ts-node
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json TS_NODE_TRANSPILE_ONLY=true \
  NODE_OPTIONS=--no-experimental-strip-types \
  npx ts-mocha -p ./tsconfig.json -t 1000000 ${TESTES:-tests/cofre.ts}
