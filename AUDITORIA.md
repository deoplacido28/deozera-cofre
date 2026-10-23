# Auditoria do cofre DeoZERA

Documento para pedir orçamentos de auditoria independente do programa Solana `cofre` e registro das revisões internas.

## O que é o programa (escopo)
- **Linguagem/biblioteca:** Rust, **Pinocchio 0.9.3** (no_std, sem alocador), Solana Agave 2.x. Interface compatível com Anchor (mesmos identificadores de instrução e conta), descrita à mão em `idl/cofre.json`.
- **Arquivo:** `programs/cofre/src/lib.rs` (~800 linhas). Chama só o System Program e o SPL Token clássico.
- **Tamanho:** 82,2 KB (depósito na rede ~0,57 SOL).
- **Moeda:** USDC (SPL Token clássico), gravada na inicialização e imutável.
- **Instruções (17):**
  - Config: `inicializar` (só a autoridade de atualização), `atualizar_config`, `propor_admin`, `aceitar_admin`.
  - Cofre: `abrir_cofre`, `depositar`, `sacar`, `fechar_cofre`, `trancar_saldo`.
  - Chave de aposta: `autorizar_sessao`, `revogar_sessao`, `entrar_partida_sessao`.
  - Partidas: `criar_partida`, `entrar_partida`, `liquidar_partida`, `cancelar_partida`.
- **Contas (PDAs):** `Config` (`config`), `Cofre` por usuário (`cofre`+dono) com a conta de tokens (`tokens`+dono), `Sessao` (`sessao`+dono+chave), `Partida` (`partida`+id u64).

## Garantias (o que a auditoria deve confirmar)
1. **Saque:** só o dono, só para uma conta de tokens dele; funciona mesmo com o programa pausado.
2. **Aposta:** só trava com a assinatura do dono **ou** de uma chave de aposta que o dono autorizou pela wallet. A chave só trava aposta: não saca, não transfere, não tranca. `entrar_partida_sessao` exige o valor exato da partida (`ApostaDiferente`).
3. **Saldo trancado:** só o dono tranca e destranca; trancado, nenhuma chave de aposta aposta.
4. **Árbitro (servidor):** cria partidas e informa o resultado e quem abandonou; o valor travado só se move entre os jogadores daquela partida, com uma única saída: a **pool de abandono** (o que quem abandonou receberia vai para a conta de tokens da carteira de taxas configurada; nunca mais que a parte dele, nunca todos os jogadores; os outros recebem o mesmo). Aposta com teto (`teto_aposta`). Não saca nem trava aposta de ninguém. Risco aceito: um árbitro comprometido poderia marcar abandono falso e mandar a parte de alguém para a carteira de taxas (limitado à aposta daquela partida; cada caso fica público na transação e na pool).
5. **Prazos:** se o árbitro não liquidar em 24 h (ou a partida não encher em 10 min), qualquer um cancela e todos recebem de volta.
6. **Taxa:** só no saque, teto fixo de 20% no código, só para a conta de tokens da carteira de taxas configurada.
7. **Tetos de depósito (opcionais, 0 = sem teto):** por cofre e total; só barram depósito, nunca saque, aposta ou pagamento.
8. **Administração:** só a autoridade de atualização inicializa; troca de admin em duas etapas; a moeda não muda.
9. **Contabilidade:** tokens da conta do cofre = `saldo` + `travado` em qualquer sequência de operações; `total_no_cofre` = depositado − sacado.

## Checagens manuais (o que o Anchor fazia sozinho)
Em toda conta recebida: dono = programa, identificador de 8 bytes, tamanho mínimo, endereço (PDA) recalculado com o bump gravado e as sementes do dono/chave, e quem assina. Contas de token: programa de token clássico, 165 bytes, estado inicializado, dono e moeda. Criação de PDA trata SOL mandado antes para o endereço. Contas fechadas zeram dados e voltam ao System Program (sem "ressuscitar" na mesma transação).

## Testes
- `npm test` (`scripts/testar.sh`): **24 testes**, um por regra, incluindo as fraudes (sacar do cofre de outro, taxa para outra carteira, liquidar com contas trocadas ou fora de ordem, pagador errado, aposta acima do teto, jogador repetido, contas imitadas, dados cortados, SOL mandado antes ao endereço do cofre, chave de aposta em cofre alheio, chave revogada, trancar o saldo de outro, tetos).
- **Teste de ataque aleatório** (`tests/fuzz.ts`, `TESTES=tests/fuzz.ts PASSOS=1500 SEMENTE=n npm test`): sorteia operações válidas e maliciosas e confere, depois de **cada** passo, as invariantes 1–9 (tokens = saldo + travado em todo cofre; soma dos cofres = depositado − sacado; travado = apostas abertas; total da config; pagamento exato da liquidação: vencedor +2× aposta, empate devolve, perdedor nada) e que todo ataque falha.

## Revisão interna de 22/10/2026 (resultado)
- **Contrato:** releitura completa com foco em contas imitadas, confusão de tipos (identificador + tamanho), PDAs com bump gravado, assinaturas, revivência de contas fechadas, ordem das contas na liquidação, prazos de cancelamento e tetos. **Nenhuma falha encontrada.**
- **Ataque aleatório:** semente 7 (400 passos, 50 ataques), sementes 11 e 23 (1.500 passos cada, 216 e 237 ataques) e semente 42 (1.500 passos, 214 ataques): **todas as invariantes mantidas em todos os passos e todos os ataques barrados.**
- **Tamanho:** 94,9 → 79,5 KB sem mudar comportamento (sem `unwrap`, taxa em u64, aluguel sem ponto flutuante); 82,2 KB com os tetos.

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
> We are DeoZERA, a small skill-gaming platform on Solana. We would like a quote for a security audit of a single program written with Pinocchio (no Anchor; ~800 lines, 17 instructions, SPL Token USDC only). User balances live in per-user PDAs with a PDA-owned token account; players lock stakes for a match either with their wallet signature or with a "session key" they authorized from their wallet (it can only lock stakes, never withdraw), and can freeze all session keys from their wallet. An arbiter key settles matches only among the match participants, with timeouts that let anyone cancel and refund. Withdrawal fees have a hard-coded cap; optional deposit caps per vault and in total.
>
> We can share the repository, a written spec, the unit tests and a randomized invariant (fuzz) test. Target window: [dates]. Please send pricing, availability and whether you can also help with a verified build.
>
> Thank you,
> [Name] – DeoZERA – deozera.com.br
