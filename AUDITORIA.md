# Auditoria do cofre DeoZERA

Documento para pedir orçamentos de auditoria independente do programa Solana `cofre` e registro das revisões internas.

## O que é o programa (escopo)
- **Linguagem/biblioteca:** Rust, **Pinocchio 0.9.3** (no_std, sem alocador), Solana Agave 2.x. Interface compatível com Anchor (mesmos identificadores de instrução e conta), descrita à mão em `idl/cofre.json`.
- **Arquivo:** `programs/cofre/src/lib.rs` (~830 linhas). Chama só o System Program e o SPL Token clássico.
- **Tamanho:** 93.976 bytes no build verificável de 25/10/2026 (partidas de vários lados: +2.056 bytes; hash `f3db3b28…f827d`); depósito na rede ~0,65 SOL.
- **Moeda:** USDC (SPL Token clássico), gravada na inicialização e imutável.
- **Instruções (18):**
  - Config: `inicializar` (só a autoridade de atualização), `atualizar_config`, `propor_admin`, `aceitar_admin`.
  - Cofre: `abrir_cofre`, `depositar`, `sacar`, `fechar_cofre`, `trancar_saldo`, `comprar` (compra na plataforma).
  - Chave de aposta: `autorizar_sessao`, `revogar_sessao`, `entrar_partida_sessao`.
  - Partidas: `criar_partida`, `entrar_partida`, `liquidar_partida`, `cancelar_partida`.
- **Contas (PDAs):** `Config` (`config`), `Cofre` por usuário (`cofre`+dono) com a conta de tokens (`tokens`+dono), `Sessao` (`sessao`+dono+chave), `Partida` (`partida`+id u64).
- **Partidas (desde 25/10/2026):** de 2 a 8 **lados** do mesmo tamanho, no máximo 8 jogadores: dois times (1x1 a 4x4, o formato original) ou vários lados (ex.: 3 ou 4 jogadores cada um por si). O `criar_partida` recebe os lados além dos dois primeiros num campo opcional no fim (`outros_times`); sem ele, os bytes são os de antes. Resultado: 0 = empate/devolve, k = o lado k venceu.

## Garantias (o que a auditoria deve confirmar)
1. **Saque:** só o dono, só para uma conta de tokens dele; funciona mesmo com o programa pausado.
2. **Aposta:** só trava com a assinatura do dono **ou** de uma chave de aposta que o dono autorizou pela wallet. A chave só trava aposta: não saca, não transfere, não tranca. `entrar_partida_sessao` exige o valor exato da partida (`ApostaDiferente`).
3. **Saldo trancado:** só o dono tranca e destranca; trancado, nenhuma chave de aposta aposta.
4. **Árbitro (servidor):** cria partidas (2 a 8 lados do mesmo tamanho, sem jogador repetido, no máximo 8) e informa o resultado (um lado que existe, ou 0) e quem abandonou; o valor travado só se move entre os jogadores daquela partida, com duas saídas, ambas só para a conta de tokens da carteira de taxas configurada: a **taxa da partida** (item 6) e a **pool de abandono** (o que quem abandonou receberia vai para a conta de tokens da carteira de taxas configurada; nunca mais que a parte dele, nunca todos os jogadores; os outros recebem o mesmo). Aposta com teto (`teto_aposta`). Não saca nem trava aposta de ninguém. Risco aceito: um árbitro comprometido poderia marcar abandono falso e mandar a parte de alguém para a carteira de taxas (limitado à aposta daquela partida; cada caso fica público na transação e na pool).
5. **Prazos:** se o árbitro não liquidar em 24 h (ou a partida não encher em 10 min), qualquer um cancela e todos recebem de volta.
6. **Taxa (desde 26/10/2026):** só nas partidas com vencedor: `taxa_partida_bps` do pote (as apostas de todos os lados), tirada do que o lado vencedor recebe, por vencedor (`lados × aposta × bps / 10000`, arredondado para baixo; com dois times é o par perdedor → vencedor, `2 × aposta × bps / 10000`). O jogador j do lado vencedor recebe a aposta do jogador j de cada lado perdedor; o primeiro desses perdedores paga a taxa dele (no máximo 80% de uma aposta, com 8 lados e 10%), com teto fixo de 10% do pote no código, só para a conta de tokens da carteira de taxas configurada. Empate, cancelamento, depósito e saque: sem taxa. Com taxa > 0, a liquidação com vencedor exige a conta da carteira de taxas (número exato de contas).
6a. **Compra na plataforma (cosméticos, desde 26/10/2026):** `comprar(valor, pedido)` só com a assinatura da wallet do dono (a chave de aposta não compra), só do saldo livre, só para a conta de tokens da carteira de taxas configurada, no máximo 100 USDC por compra (fixo no código) e nunca com o programa pausado.
7. **Tetos de depósito (opcionais, 0 = sem teto):** por cofre e total; só barram depósito, nunca saque, aposta ou pagamento.
8. **Administração:** só a autoridade de atualização inicializa; troca de admin em duas etapas; a moeda não muda.
9. **Contabilidade:** tokens da conta do cofre = `saldo` + `travado` em qualquer sequência de operações; `total_no_cofre` = depositado − sacado − taxas − pool; a carteira de taxas recebe exatamente as taxas cobradas.

## Checagens manuais (o que o Anchor fazia sozinho)
Em toda conta recebida: dono = programa, identificador de 8 bytes, tamanho mínimo, endereço (PDA) recalculado com o bump gravado e as sementes do dono/chave, e quem assina. Contas de token: programa de token clássico, 165 bytes, estado inicializado, dono e moeda. Criação de PDA trata SOL mandado antes para o endereço. Contas fechadas zeram dados e voltam ao System Program (sem "ressuscitar" na mesma transação).

## Testes
- `npm test` (`scripts/testar.sh`): **28 testes**, um por regra (incluindo 3 e 4 jogadores cada um por si, 3 lados de 2, arredondamento, abandonos e o formato antigo do servidor), incluindo as fraudes (sacar do cofre de outro, taxa da partida desviada para outra conta ou liquidação sem a conta de taxas, liquidar com contas trocadas ou fora de ordem, pagador errado, aposta acima do teto, jogador repetido, contas imitadas, dados cortados, SOL mandado antes ao endereço do cofre, chave de aposta em cofre alheio, chave revogada, trancar o saldo de outro, tetos).
- **Teste de ataque aleatório** (`tests/fuzz.ts`, `TESTES=tests/fuzz.ts PASSOS=1500 SEMENTE=n npm test`): sorteia operações válidas e maliciosas e confere, depois de **cada** passo, as invariantes 1–9 (tokens = saldo + travado em todo cofre; soma dos cofres = depositado − sacado; travado = apostas abertas; total da config; pagamento exato da liquidação com 1x1, 2x2, 3 e 4 cada um por si e abandonos sorteados: vencedor + (lados − 1) apostas − taxa, empate devolve, perdedor nada, quem abandonou nada (pool), resultado de lado inexistente e todos abandonando recusados; carteira de taxas = taxas cobradas; taxa mudada ao acaso entre 0, 5% e 10%) e que todo ataque falha (inclusive desviar a taxa ou liquidar sem a conta de taxas).

## Revisão interna de 22/10/2026 (resultado)
- **Contrato:** releitura completa com foco em contas imitadas, confusão de tipos (identificador + tamanho), PDAs com bump gravado, assinaturas, revivência de contas fechadas, ordem das contas na liquidação, prazos de cancelamento e tetos. **Nenhuma falha encontrada.**
- **Ataque aleatório:** semente 7 (400 passos, 50 ataques), sementes 11 e 23 (1.500 passos cada, 216 e 237 ataques) e semente 42 (1.500 passos, 214 ataques): **todas as invariantes mantidas em todos os passos e todos os ataques barrados.**
- **Tamanho:** 94,9 → 79,5 KB sem mudar comportamento (sem `unwrap`, taxa em u64, aluguel sem ponto flutuante); 82,2 KB com os tetos.

## Revisão interna de 25/10/2026 (partidas de vários lados)
- **Contrato:** leitura do campo opcional `outros_times` (só no fim, lados do mesmo tamanho, total ≤ 8, laço limitado, lixo depois recusado), partidas antigas lidas como 2 lados, conservação (cada perdedor paga exatamente uma aposta; cada vencedor recebe (lados − 1) apostas − taxa), saídas do grupo só pela taxa e pela pool, resultado só de lado que existe. **Nenhuma falha encontrada.** Com 2 lados, as mesmas transferências e a mesma taxa de antes.
- **Testes:** 28 (inclui 3, 4 e 8 cada um por si, 3 lados de 2, 4x4, arredondamento, abandonos e o formato antigo do servidor) e ataque aleatório com lados e abandonos sorteados (semente 24, 1.500 passos, 167 ataques): todas as invariantes mantidas.
- **Risco novo fora do contrato:** conluio entre jogadores numa partida de cada um por si (dois contra um, ou uma pessoa com duas contas). Fica com o antifraude do jogo.

## Plano até o dinheiro real
1. Congelar o código do contrato (versão desta revisão).
2. Revisão independente: auditor freelancer ou empresa especialista em Solana (orçamento abaixo). Corrigir achados e pedir a revisão das correções.
3. **Build verificado** (Solana Verify / OtterSec): o código do repositório é o mesmo que roda na blockchain. **Feito na devnet (22/10/2026):** código público em github.com/deoplacido28/deozera-cofre; o GitHub Actions compila na imagem oficial `solana-verifiable-build:2.1.21` (reproduzível: duas rodadas, mesmo hash `549e42d2…f8f6e`) e publica o `.so` como versão; a devnet roda exatamente esse arquivo. Na mainnet falta registrar na OtterSec.
4. `security.txt` embutido no programa com o contato de segurança. **Feito (22/10/2026):** contato contato@deozera.com.br (ativo), política em deozera.com.br/seguranca e `/.well-known/security.txt` no site.
5. Autoridade de atualização numa **multiassinatura Squads** do dono.
6. Beta com tetos baixos (`teto_saldo`, `teto_total`) e depois sem teto.
7. Página de segurança no site e recompensa por falhas (bug bounty) depois do lançamento.

## Pedido de orçamento (modelo, em inglês)
> Subject: Audit quote request: Solana Pinocchio program (~800 LoC, 17 instructions)
>
> Hello,
>
> We are DeoZERA, a small skill-gaming platform on Solana. We would like a quote for a security audit of a single program written with Pinocchio (no Anchor; ~800 lines, 17 instructions, SPL Token USDC only). User balances live in per-user PDAs with a PDA-owned token account; players lock stakes for a match either with their wallet signature or with a "session key" they authorized from their wallet (it can only lock stakes, never withdraw), and can freeze all session keys from their wallet. An arbiter key settles matches only among the match participants, with timeouts that let anyone cancel and refund. The platform fee is a percentage of the match pot, taken only from the winners' payout, with a hard-coded cap (no deposit or withdrawal fees); optional deposit caps per vault and in total.
>
> We can share the repository, a written spec, the unit tests and a randomized invariant (fuzz) test. Target window: [dates]. Please send pricing, availability and whether you can also help with a verified build.
>
> Thank you,
> [Name] – DeoZERA – deozera.com.br

## Mudança de 26/10/2026: taxa das partidas no lugar da taxa de saque
- **Decisão do dono:** a taxa da plataforma saiu do saque (10%) e foi para as partidas com vencedor: **5% do pote** (`taxa_partida_bps = 500`), teto fixo de **10% do pote** no código (`TAXA_MAXIMA_BPS = 1000`). O campo da configuração continua no mesmo lugar (byte 104), com o novo significado.
- **Contrato:** `sacar` não cobra nada e não recebe mais a conta da carteira de taxas (6 contas). `liquidar_partida`: em cada par perdedor → vencedor, o perdedor manda `aposta − taxa_par` ao vencedor e `taxa_par` à carteira de taxas (se o vencedor abandonou, a aposta inteira vai para a carteira de taxas: taxa + pool); a configuração vem gravável e `total_no_cofre` diminui pela taxa + pool. Empate: sem taxa (a conta de taxas a mais é recusada).
- **Testes:** 25 (novos: liquidação 1x1 com taxa e as tentativas de desvio; 2x2 com 5%, 10% e 0%; arredondamento para baixo; empate sem taxa; saque sem taxa) e o teste de ataque aleatório com as invariantes da taxa.

## Antes de trancar o contrato (26/10/2026)
- Plano do dono: tirar a autoridade de atualização (contrato imutável) depois de definir todas as regras. Para isso: instrução `comprar` (cosméticos) e `aluguel_minimo` aceitando qualquer limite de isenção que a rede adotar no futuro (antes, só 1,0 e 2,0: um contrato imutável pararia de abrir cofres se a rede mudasse o aluguel). 26 testes; ataque aleatório sementes 7, 11 e 42 (427 ataques barrados) com as compras nas invariantes.
