# Cofre DeoZERA

Programa Solana que guarda os saldos (em USDC) dos jogadores da [DeoZERA](https://deozera.com.br) e trava as apostas das partidas. Escrito em Rust com [Pinocchio](https://github.com/anza-xyz/pinocchio).

O código está público para que qualquer pessoa confira **o que o programa faz** e **que o programa rodando na Solana é exatamente este código** (build verificável, abaixo).

| Rede | Endereço do programa |
|---|---|
| Mainnet | `HMPj2NkqVJJUpjg4TxMjCfDCc8NLSUV5VN32DRzzy25n` (roda o build verificável; o hash fica na versão `build-<commit>` e no resumo do Actions) |
| Devnet (testes, versão anterior) | `E2zft5kPUBFgwbJYLSLMdx92TDT4Ajyddtczg3ByJ3XX` |

## O que o programa garante
- **Saque:** só o dono do cofre saca, e só para uma conta dele. O saque funciona até com o programa pausado.
- **Aposta:** só trava com a assinatura do dono ou de uma "chave de aposta" que ele autorizou pela própria carteira. Essa chave só trava aposta: não saca, não transfere e o dono revoga quando quiser.
- **Saldo trancado:** o dono pode trancar o saldo pela carteira; trancado, nenhuma chave de aposta aposta.
- **Partidas:** de 2 a 8 lados do mesmo tamanho, no máximo 8 jogadores: dois times (1x1 a 4x4) ou vários lados, por exemplo 3 ou 4 jogadores cada um por si. Vence um lado só; no empate todos recebem de volta.
- **Árbitro (servidor):** só cria a partida e informa o resultado e quem abandonou. O valor travado se move entre os jogadores daquela partida; as únicas saídas são a **taxa da partida** (abaixo) e a **pool de abandono**: o que quem abandonou receberia vai para a carteira de taxas (nunca mais que a parte dele, nunca todos os jogadores; os outros recebem o mesmo). Aposta tem teto.
- **Prazos:** se o resultado não for informado em 24 h (ou a partida não encher em 10 min), qualquer pessoa cancela e todos recebem de volta.
- **Taxa:** só nas partidas com vencedor, uma porcentagem do pote (hoje 5%) tirada do que o vencedor recebe, com teto fixo de 10% do pote no código, e só para a carteira de taxas configurada. Depósito, saque, empate e cancelamento não têm taxa.
- **Compra na plataforma (cosméticos):** só com a assinatura da wallet do dono, só do saldo livre, só para a carteira de taxas, no máximo 100 USDC por compra (fixo no código).
- **Moeda:** USDC, gravada na inicialização e imutável.

Detalhes, testes e resultado da revisão interna: [AUDITORIA.md](AUDITORIA.md). Interface (instruções e contas): [idl/cofre.json](idl/cofre.json).

## Conferir que o programa na rede é este código
A compilação reproduzível usa a imagem Docker oficial da Solana, então o arquivo gerado é sempre idêntico byte a byte. O GitHub Actions deste repositório faz isso a cada mudança (aba **Actions**, fluxo "Build verificavel", com o hash no resumo e o `.so` para baixar).

Para conferir por conta própria (precisa de Docker e Rust):

```bash
cargo install solana-verify --locked
solana-verify build --library-name cofre --base-image solanafoundation/solana-verifiable-build:2.1.21
solana-verify get-executable-hash target/deploy/cofre.so
solana-verify get-program-hash -u https://api.mainnet-beta.solana.com HMPj2NkqVJJUpjg4TxMjCfDCc8NLSUV5VN32DRzzy25n
```

Se os dois hashes forem iguais, o programa da rede é exatamente o deste código.

## Testes
26 testes (um por regra, incluindo as tentativas de fraude) e um teste de ataque aleatório que confere as regras de contabilidade a cada operação. Rodam numa blockchain Solana local (precisa do Solana 2.1.21, Rust e Node 22):

```bash
npm ci
npm test
TESTES=tests/fuzz.ts PASSOS=1500 SEMENTE=7 npm test   # ataque aleatório (reproduzível pela semente)
```

## Segurança
Achou uma falha? Veja [SECURITY.md](SECURITY.md). O contato também está embutido no próprio programa (padrão `security.txt` da Solana).

## Licença
Código publicado para transparência e verificação. Todos os direitos reservados.
