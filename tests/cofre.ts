// Testes do cofre DeoZERA (rodam numa blockchain Solana local: npm test, que usa scripts/testar.sh).
// Cada regra de seguranca tem um teste que tenta quebra-la. A moeda e um "USDC de teste" (6 casas) criado aqui.
import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { createAccount, createAssociatedTokenAccount, createMint, getAccount, mintTo, transfer } from '@solana/spl-token';
import { expect } from 'chai';
import { readFileSync } from 'fs';

// Roda a partir da pasta solana/ (scripts/testar.sh)
const idl = JSON.parse(readFileSync('idl/cofre.json', 'utf8'));

const { Keypair, PublicKey, LAMPORTS_PER_SOL } = anchor.web3;
type Chave = anchor.web3.PublicKey;
const USDC = (n: number) => new BN(Math.round(n * 1_000_000));
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

describe('cofre', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // O programa e escrito com Pinocchio; o IDL (escrito a mao, igual ao da versao Anchor) descreve a interface
  const program = new Program(idl as anchor.Idl, provider);
  const conn = provider.connection;
  const pagador = (provider.wallet as anchor.Wallet).payer;

  const arbitro = Keypair.generate();
  const taxas = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const carol = Keypair.generate();
  let moeda: Chave; let moedaFalsa: Chave;
  const ata: Record<string, Chave> = {}; // conta de USDC (associada) de cada um
  let taxasUsdc: Chave;

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
  const cofreDe = (k: Chave) => PublicKey.findProgramAddressSync([Buffer.from('cofre'), k.toBuffer()], program.programId)[0];
  const tokensDe = (k: Chave) => PublicKey.findProgramAddressSync([Buffer.from('tokens'), k.toBuffer()], program.programId)[0];
  const partidaDe = (id: number) => PublicKey.findProgramAddressSync([Buffer.from('partida'), new BN(id).toArrayLike(Buffer, 'le', 8)], program.programId)[0];
  const sessaoDe = (dono: Chave, chave: Chave) => PublicKey.findProgramAddressSync([Buffer.from('sessao'), dono.toBuffer(), chave.toBuffer()], program.programId)[0];
  const [dadosPrograma] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], LOADER);
  const usdc = async (conta: Chave) => Number((await getAccount(conn, conta)).amount);
  const cofre = async (k: Chave) => program.account.cofre.fetch(cofreDe(k));
  const sacar = (k: anchor.web3.Keypair, valor: BN, extra: Record<string, Chave> = {}) => program.methods.sacar(valor)
    .accountsPartial({ dono: k.publicKey, destino: ata[k.publicKey.toBase58()], ...extra }).signers([k]).rpc();
  const depositar = (k: anchor.web3.Keypair, valor: BN, extra: Record<string, Chave> = {}) => program.methods.depositar(valor)
    .accountsPartial({ dono: k.publicKey, origem: ata[k.publicKey.toBase58()], ...extra }).signers([k]).rpc();
  // Contas restantes da liquidacao: cofre + conta de tokens de cada jogador, na ordem da partida
  const pares = (lista: Chave[]) => lista.flatMap((k) => [cofreDe(k), tokensDe(k)]).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
  // Partida com vencedor: depois dos pares vem a conta de USDC da carteira de taxas (a taxa da partida vai para ela)
  const comTaxas = (lista: Chave[]) => [...pares(lista), { pubkey: taxasUsdc, isSigner: false, isWritable: true }];

  // Confere o erro pelo codigo do programa (6000 + posicao), procurando o nome no IDL
  async function falha(promessa: Promise<unknown>, nome?: string) {
    try { await promessa; } catch (e) {
      if (nome) {
        const codigo = (idl.errors as { code: number; name: string }[]).find((x) => x.name === nome)!.code;
        const texto = String((e as Error).message ?? e) + ' ' + JSON.stringify(e);
        const achou = (e as { code?: number }).code === codigo || texto.includes('0x' + codigo.toString(16)) || texto.includes(nome);
        expect(achou, `esperava ${nome} (${codigo}), veio: ${texto.slice(0, 300)}`).to.equal(true);
      }
      return;
    }
    expect.fail('deveria ter falhado');
  }

  before(async () => {
    for (const k of [arbitro, taxas, alice, bob, carol]) {
      const sig = await conn.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
    }
    moeda = await createMint(conn, pagador, pagador.publicKey, null, 6);
    moedaFalsa = await createMint(conn, pagador, pagador.publicKey, null, 6);
    for (const k of [alice, bob, carol]) {
      ata[k.publicKey.toBase58()] = await createAssociatedTokenAccount(conn, pagador, moeda, k.publicKey);
      await mintTo(conn, pagador, moeda, ata[k.publicKey.toBase58()], pagador, 100_000_000); // 100 USDC
    }
    taxasUsdc = await createAssociatedTokenAccount(conn, pagador, moeda, taxas.publicKey);
  });

  it('so a autoridade de atualizacao do programa inicializa (e a moeda fica gravada)', async () => {
    await falha(program.methods.inicializar(arbitro.publicKey, taxas.publicKey, 500, USDC(50))
      .accountsPartial({ config, admin: alice.publicKey, dadosPrograma, moeda }).signers([alice]).rpc(), 'NaoAutorizado');
    await falha(program.methods.inicializar(arbitro.publicKey, taxas.publicKey, 1001, USDC(50))
      .accountsPartial({ config, admin: provider.wallet.publicKey, dadosPrograma, moeda }).rpc(), 'TaxaAcimaDoTeto');
    await program.methods.inicializar(arbitro.publicKey, taxas.publicKey, 500, USDC(50))
      .accountsPartial({ config, admin: provider.wallet.publicKey, dadosPrograma, moeda }).rpc();
    const c = await program.account.config.fetch(config);
    expect(c.taxaPartidaBps).to.equal(500); // 5% do pote
    expect(c.moeda.toBase58()).to.equal(moeda.toBase58());
  });

  it('taxa nunca passa do teto fixo (10% do pote) e so o admin muda a configuracao', async () => {
    await falha(program.methods.atualizarConfig(null, null, 1001, null, null, null, null).accountsPartial({ config }).rpc(), 'TaxaAcimaDoTeto');
    await falha(program.methods.atualizarConfig(null, null, 0, null, null, null, null)
      .accountsPartial({ config, admin: alice.publicKey }).signers([alice]).rpc(), 'NaoAutorizado');
  });

  it('cofre so abre com a moeda configurada', async () => {
    await falha(program.methods.abrirCofre().accountsPartial({ dono: alice.publicKey, moeda: moedaFalsa }).signers([alice]).rpc(), 'MoedaInvalida');
  });

  it('cada um abre o proprio cofre e deposita da propria conta', async () => {
    for (const k of [alice, bob]) {
      await program.methods.abrirCofre().accountsPartial({ dono: k.publicKey, moeda }).signers([k]).rpc();
      await depositar(k, USDC(20));
    }
    expect((await cofre(alice.publicKey)).saldo.toString()).to.equal(USDC(20).toString());
    expect(await usdc(tokensDe(alice.publicKey))).to.equal(20_000_000);
    expect(await usdc(ata[alice.publicKey.toBase58()])).to.equal(80_000_000);
  });

  it('ninguem deposita com o dinheiro de outro, nem com outra moeda', async () => {
    // Bob tenta usar a conta de USDC da Alice como origem
    await falha(depositar(bob, USDC(1), { origem: ata[alice.publicKey.toBase58()] }), 'NaoAutorizado');
    const falsa = await createAccount(conn, pagador, moedaFalsa, bob.publicKey, Keypair.generate());
    await mintTo(conn, pagador, moedaFalsa, falsa, pagador, 5_000_000);
    await falha(depositar(bob, USDC(1), { origem: falsa }), 'MoedaInvalida');
  });

  it('ninguem saca do cofre de outro nem para a conta de outro', async () => {
    await falha(program.methods.sacar(USDC(1))
      .accountsPartial({ cofre: cofreDe(alice.publicKey), tokens: tokensDe(alice.publicKey), dono: bob.publicKey, destino: ata[bob.publicKey.toBase58()] })
      .signers([bob]).rpc());
    // Alice assina, mas manda o saque para a conta do Bob
    await falha(sacar(alice, USDC(1), { destino: ata[bob.publicKey.toBase58()] }), 'NaoAutorizado');
  });

  it('saque sem taxa: o valor inteiro vai para o dono (nada para a carteira de taxas)', async () => {
    const antesAlice = await usdc(ata[alice.publicKey.toBase58()]);
    const antesTaxas = await usdc(taxasUsdc);
    await sacar(alice, USDC(10));
    expect((await usdc(taxasUsdc)) - antesTaxas).to.equal(0);
    expect((await usdc(ata[alice.publicKey.toBase58()])) - antesAlice).to.equal(10_000_000);
    expect((await cofre(alice.publicKey)).saldo.toString()).to.equal(USDC(10).toString());
    expect(await usdc(tokensDe(alice.publicKey))).to.equal(10_000_000);
    await falha(sacar(alice, USDC(50)), 'SaldoInsuficiente');
  });

  it('pausado: bloqueia deposito, mas o saque continua liberado', async () => {
    await program.methods.atualizarConfig(null, null, null, null, true, null, null).accountsPartial({ config }).rpc();
    await falha(depositar(bob, USDC(1)), 'Pausado');
    await sacar(bob, USDC(1));
    await program.methods.atualizarConfig(null, null, null, null, false, null, null).accountsPartial({ config }).rpc();
    await depositar(bob, USDC(1));
  });

  it('so o arbitro cria partida, dentro do teto e sem jogador repetido', async () => {
    await falha(program.methods.criarPartida(new BN(1), USDC(5), [alice.publicKey], [bob.publicKey])
      .accountsPartial({ arbitro: alice.publicKey }).signers([alice]).rpc(), 'NaoAutorizado');
    await falha(program.methods.criarPartida(new BN(1), USDC(60), [alice.publicKey], [bob.publicKey])
      .accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc(), 'ApostaForaDoTeto');
    await falha(program.methods.criarPartida(new BN(1), USDC(5), [alice.publicKey], [alice.publicKey])
      .accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc(), 'JogadorRepetido');
    await program.methods.criarPartida(new BN(1), USDC(5), [alice.publicKey], [bob.publicKey])
      .accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
  });

  it('cada jogador trava a propria aposta (quem nao esta na partida nao entra)', async () => {
    const partida = partidaDe(1);
    await program.methods.abrirCofre().accountsPartial({ dono: carol.publicKey, moeda }).signers([carol]).rpc();
    await depositar(carol, USDC(10));
    await falha(program.methods.entrarPartida().accountsPartial({ partida, jogador: carol.publicKey }).signers([carol]).rpc(), 'NaoEstaNaPartida');
    await program.methods.entrarPartida().accountsPartial({ partida, jogador: alice.publicKey }).signers([alice]).rpc();
    await falha(program.methods.entrarPartida().accountsPartial({ partida, jogador: alice.publicKey }).signers([alice]).rpc(), 'JaEntrou');
    await falha(program.methods.liquidarPartida(1, null).accountsPartial({ partida, arbitro: arbitro.publicKey, pagador: arbitro.publicKey })
      .remainingAccounts(pares([alice.publicKey, bob.publicKey])).signers([arbitro]).rpc(), 'EstadoInvalido');
    await program.methods.entrarPartida().accountsPartial({ partida, jogador: bob.publicKey }).signers([bob]).rpc();
    expect((await cofre(alice.publicKey)).travado.toString()).to.equal(USDC(5).toString());
  });

  it('so o arbitro liquida, com as contas certas; o vencedor recebe o pote menos 5% (a taxa vai so para a carteira de taxas)', async () => {
    const partida = partidaDe(1);
    const liquidar = (quem: anchor.web3.Keypair, contas: ReturnType<typeof pares>) => program.methods.liquidarPartida(1, null)
      .accountsPartial({ partida, arbitro: quem.publicKey, pagador: arbitro.publicKey }).remainingAccounts(contas).signers([quem]).rpc();
    await falha(liquidar(alice, comTaxas([alice.publicKey, bob.publicKey])), 'NaoAutorizado');
    await falha(liquidar(arbitro, comTaxas([bob.publicKey, alice.publicKey])), 'ContasInvalidas'); // ordem errada
    await falha(liquidar(arbitro, comTaxas([alice.publicKey, carol.publicKey])), 'ContasInvalidas'); // quem nao jogou
    // Conta de tokens trocada: o cofre da Bob com a conta de tokens da Carol (desviar para fora do grupo)
    const trocada = comTaxas([alice.publicKey, bob.publicKey]);
    trocada[3] = { pubkey: tokensDe(carol.publicKey), isSigner: false, isWritable: true };
    await falha(liquidar(arbitro, trocada), 'ContasInvalidas');
    // Taxa: sem a conta da carteira de taxas nao liquida; desviar a taxa para outra conta tambem nao
    await falha(liquidar(arbitro, pares([alice.publicKey, bob.publicKey])), 'ContasInvalidas');
    const desvio = comTaxas([alice.publicKey, bob.publicKey]);
    desvio[4] = { pubkey: ata[carol.publicKey.toBase58()], isSigner: false, isWritable: true };
    await falha(liquidar(arbitro, desvio), 'CarteiraDeTaxasErrada');
    desvio[4] = { pubkey: tokensDe(alice.publicKey), isSigner: false, isWritable: true }; // a taxa para o proprio vencedor
    await falha(liquidar(arbitro, desvio), 'CarteiraDeTaxasErrada');

    const total = async () => (await usdc(tokensDe(alice.publicKey))) + (await usdc(tokensDe(bob.publicKey)));
    const antes = await total();
    const antesTaxas = await usdc(taxasUsdc);
    const antesCfg = (await program.account.config.fetch(config)).totalNoCofre.toNumber();
    await liquidar(arbitro, comTaxas([alice.publicKey, bob.publicKey]));
    const a = await cofre(alice.publicKey); const b = await cofre(bob.publicKey);
    expect(a.saldo.toString()).to.equal(USDC(14.5).toString()); // 5 livres + venceu (5 de volta + 5 do Bob - 0,50 de taxa)
    expect(a.travado.toNumber()).to.equal(0);
    expect(b.travado.toNumber()).to.equal(0);
    expect(await usdc(tokensDe(alice.publicKey))).to.equal(14_500_000); // os tokens acompanham a contabilidade
    expect((await usdc(taxasUsdc)) - antesTaxas).to.equal(500_000); // 5% do pote de 10
    expect(antes - (await total())).to.equal(500_000); // do grupo de jogadores so saiu a taxa
    expect(antesCfg - (await program.account.config.fetch(config)).totalNoCofre.toNumber()).to.equal(500_000);
    expect(await conn.getAccountInfo(partida)).to.equal(null); // conta da partida fechada
  });

  it('cancelamento devolve as apostas; so o arbitro cancela antes dos prazos', async () => {
    await program.methods.criarPartida(new BN(2), USDC(3), [alice.publicKey], [bob.publicKey])
      .accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
    const partida = partidaDe(2);
    await program.methods.entrarPartida().accountsPartial({ partida, jogador: alice.publicKey }).signers([alice]).rpc();
    const contas = [{ pubkey: cofreDe(alice.publicKey), isSigner: false, isWritable: true }];
    await falha(program.methods.cancelarPartida().accountsPartial({ partida, quem: bob.publicKey, pagador: arbitro.publicKey })
      .remainingAccounts(contas).signers([bob]).rpc(), 'NaoAutorizado');
    await program.methods.cancelarPartida().accountsPartial({ partida, quem: arbitro.publicKey, pagador: arbitro.publicKey })
      .remainingAccounts(contas).signers([arbitro]).rpc();
    const a = await cofre(alice.publicKey);
    expect(a.saldo.toString()).to.equal(USDC(14.5).toString());
    expect(a.travado.toNumber()).to.equal(0);
  });

  it('cofre com saldo nao fecha; vazio fecha, devolve sobras e o aluguel', async () => {
    const dono = carol.publicKey.toBase58();
    const fechar = () => program.methods.fecharCofre().accountsPartial({ dono: carol.publicKey, destino: ata[dono] }).signers([carol]).rpc();
    await falha(fechar(), 'CofreNaoVazio');
    await sacar(carol, USDC(10));
    // Alguem manda USDC direto para a conta de tokens do cofre: nao pode impedir o fechamento
    await transfer(conn, pagador, ata[alice.publicKey.toBase58()], tokensDe(carol.publicKey), alice, 250_000);
    const antes = await usdc(ata[dono]);
    await fechar();
    expect(await usdc(ata[dono])).to.equal(antes + 250_000);
    expect(await conn.getAccountInfo(cofreDe(carol.publicKey))).to.equal(null);
    expect(await conn.getAccountInfo(tokensDe(carol.publicKey))).to.equal(null);
  });

  // ---------- Riscos especificos da versao Pinocchio (checagens escritas a mao) ----------

  it('contas falsas: configuracao, cofre e programa de token "imitados" sao recusados', async () => {
    // Uma carteira comum no lugar da configuracao
    await falha(depositar(alice, USDC(1), { config: carol.publicKey }), 'ContasInvalidas');
    // Outra conta do proprio programa (a configuracao) no lugar do cofre
    await falha(depositar(alice, USDC(1), { cofre: config }), 'ContasInvalidas');
    // Programa de token falso (o System Program) no lugar do programa de token
    await falha(sacar(alice, USDC(1), { tokenProgram: anchor.web3.SystemProgram.programId }), 'ContasInvalidas');
    // A conta de tokens do cofre de outra pessoa
    await falha(depositar(alice, USDC(1), { tokens: tokensDe(bob.publicKey) }), 'ContasInvalidas');
  });

  it('sem a assinatura do dono nada sai do cofre', async () => {
    for (const metodo of ['depositar', 'sacar'] as const) {
      const extra = metodo === 'sacar' ? { destino: ata[alice.publicKey.toBase58()] } : { origem: ata[alice.publicKey.toBase58()] };
      const ix = await program.methods[metodo](USDC(1)).accountsPartial({ dono: alice.publicKey, ...extra }).instruction();
      ix.keys.forEach((k) => { if (k.pubkey.equals(alice.publicKey)) k.isSigner = false; }); // tira a assinatura da Alice
      const tx = new anchor.web3.Transaction().add(ix); // quem assina e paga e so a carteira do teste
      await falha(provider.sendAndConfirm(tx), 'NaoAutorizado');
    }
  });

  it('dados cortados ou instrucao desconhecida sao recusados; configuracao nao inicializa duas vezes', async () => {
    const ix = await program.methods.depositar(USDC(1)).accountsPartial({ dono: alice.publicKey, origem: ata[alice.publicKey.toBase58()] }).instruction();
    ix.data = ix.data.subarray(0, 12); // valor pela metade
    await falha(provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [alice]));
    ix.data = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]); // identificador que nao existe
    await falha(provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [alice]));
    await falha(program.methods.inicializar(arbitro.publicKey, carol.publicKey, 0, USDC(50))
      .accountsPartial({ config, admin: provider.wallet.publicKey, dadosPrograma, moeda }).rpc());
  });

  it('liquidacao com pagador errado e recusada; o aluguel volta so para quem pagou', async () => {
    await program.methods.criarPartida(new BN(3), USDC(1), [alice.publicKey], [bob.publicKey]).accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
    const partida = partidaDe(3);
    for (const k of [alice, bob]) await program.methods.entrarPartida().accountsPartial({ partida, jogador: k.publicKey }).signers([k]).rpc();
    await falha(program.methods.liquidarPartida(0, null).accountsPartial({ partida, arbitro: arbitro.publicKey, pagador: bob.publicKey })
      .remainingAccounts(pares([alice.publicKey, bob.publicKey])).signers([arbitro]).rpc(), 'ContasInvalidas');
    // Empate nao tem taxa: mandar a conta da carteira de taxas a mais e recusado; sem ela, devolve tudo
    await falha(program.methods.liquidarPartida(0, null).accountsPartial({ partida, arbitro: arbitro.publicKey, pagador: arbitro.publicKey })
      .remainingAccounts(comTaxas([alice.publicKey, bob.publicKey])).signers([arbitro]).rpc(), 'ContasInvalidas');
    await program.methods.liquidarPartida(0, null).accountsPartial({ partida, arbitro: arbitro.publicKey, pagador: arbitro.publicKey })
      .remainingAccounts(pares([alice.publicKey, bob.publicKey])).signers([arbitro]).rpc();
    expect((await cofre(alice.publicKey)).saldo.toString()).to.equal(USDC(14.5).toString()); // empate: devolvido, sem taxa
  });

  it('SOL mandado antes para o endereco do cofre nao impede ninguem de abrir o proprio cofre', async () => {
    const dave = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(dave.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed');
    const tx = new anchor.web3.Transaction();
    for (const alvo of [cofreDe(dave.publicKey), tokensDe(dave.publicKey)]) {
      tx.add(anchor.web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: alvo, lamports: 1_000_000 }));
    }
    await provider.sendAndConfirm(tx);
    await program.methods.abrirCofre().accountsPartial({ dono: dave.publicKey, moeda }).signers([dave]).rpc();
    const c = await cofre(dave.publicKey);
    expect(c.dono.toBase58()).to.equal(dave.publicKey.toBase58());
    expect((await getAccount(conn, tokensDe(dave.publicKey))).owner.toBase58()).to.equal(cofreDe(dave.publicKey).toBase58());
  });

  // ---------- Chave de aposta (aposta sem abrir a wallet a cada partida) ----------

  it('chave de aposta: so o dono autoriza; trava so a aposta do dono, so com o valor da partida', async () => {
    const chave = Keypair.generate(); // gerada "no navegador": nao tem SOL, quem paga a rede e o servidor
    const sessao = sessaoDe(alice.publicKey, chave.publicKey);
    // Bob nao autoriza chave no nome da Alice (o endereco da sessao e derivado do dono que assina)
    await falha(program.methods.autorizarSessao(chave.publicKey).accountsPartial({ sessao, dono: bob.publicKey }).signers([bob]).rpc(), 'ContasInvalidas');
    await program.methods.autorizarSessao(chave.publicKey).accountsPartial({ sessao, dono: alice.publicKey }).signers([alice]).rpc();

    await program.methods.criarPartida(new BN(4), USDC(2), [alice.publicKey], [bob.publicKey]).accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
    const partida = partidaDe(4);
    const entrar = (valor: BN, k: anchor.web3.Keypair, cofreAlvo: Chave, s: Chave) => program.methods.entrarPartidaSessao(valor)
      .accountsPartial({ partida, cofre: cofreAlvo, sessao: s, chave: k.publicKey }).signers([k]).rpc();
    await falha(entrar(USDC(3), chave, cofreDe(alice.publicKey), sessao), 'ApostaDiferente'); // valor que a Alice nao escolheu
    await falha(entrar(USDC(2), chave, cofreDe(bob.publicKey), sessao), 'NaoAutorizado'); // chave da Alice no cofre do Bob
    const intrusa = Keypair.generate(); // chave nunca autorizada
    await falha(entrar(USDC(2), intrusa, cofreDe(alice.publicKey), sessaoDe(alice.publicKey, intrusa.publicKey)), 'ContasInvalidas');
    await falha(entrar(USDC(2), intrusa, cofreDe(alice.publicKey), sessao), 'NaoAutorizado'); // sessao certa, chave errada
    await entrar(USDC(2), chave, cofreDe(alice.publicKey), sessao);
    expect((await cofre(alice.publicKey)).travado.toString()).to.equal(USDC(2).toString());
    await falha(entrar(USDC(2), chave, cofreDe(alice.publicKey), sessao), 'JaEntrou');
    await program.methods.cancelarPartida().accountsPartial({ partida, quem: arbitro.publicKey, pagador: arbitro.publicKey })
      .remainingAccounts([{ pubkey: cofreDe(alice.publicKey), isSigner: false, isWritable: true }]).signers([arbitro]).rpc();
    expect((await cofre(alice.publicKey)).saldo.toString()).to.equal(USDC(14.5).toString());
  });

  it('chave de aposta nao saca; revogada pelo dono ou por ela mesma, para de valer e o aluguel volta ao dono', async () => {
    const chave = Keypair.generate();
    const sessao = sessaoDe(alice.publicKey, chave.publicKey);
    await program.methods.autorizarSessao(chave.publicKey).accountsPartial({ sessao, dono: alice.publicKey }).signers([alice]).rpc();
    // Sacar assinando com a chave de aposta: recusado (so a wallet do dono saca)
    await falha(program.methods.sacar(USDC(1)).accountsPartial({ dono: chave.publicKey, cofre: cofreDe(alice.publicKey), tokens: tokensDe(alice.publicKey),
      destino: ata[alice.publicKey.toBase58()] }).signers([chave]).rpc(), 'NaoAutorizado');
    // Bob nao revoga a chave da Alice
    await falha(program.methods.revogarSessao().accountsPartial({ sessao, dono: alice.publicKey, quem: bob.publicKey }).signers([bob]).rpc(), 'NaoAutorizado');
    const antes = await conn.getBalance(alice.publicKey);
    await program.methods.revogarSessao().accountsPartial({ sessao, dono: alice.publicKey, quem: chave.publicKey }).signers([chave]).rpc();
    expect(await conn.getAccountInfo(sessao)).to.equal(null);
    expect(await conn.getBalance(alice.publicKey)).to.be.greaterThan(antes); // aluguel de volta para a Alice
    await program.methods.criarPartida(new BN(5), USDC(1), [alice.publicKey], [bob.publicKey]).accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
    await falha(program.methods.entrarPartidaSessao(USDC(1)).accountsPartial({ partida: partidaDe(5), cofre: cofreDe(alice.publicKey), sessao, chave: chave.publicKey })
      .signers([chave]).rpc(), 'ContasInvalidas');
    // Revogar pela wallet tambem funciona
    const outra = Keypair.generate();
    const s2 = sessaoDe(alice.publicKey, outra.publicKey);
    await program.methods.autorizarSessao(outra.publicKey).accountsPartial({ sessao: s2, dono: alice.publicKey }).signers([alice]).rpc();
    await program.methods.revogarSessao().accountsPartial({ sessao: s2, dono: alice.publicKey, quem: alice.publicKey }).signers([alice]).rpc();
    expect(await conn.getAccountInfo(s2)).to.equal(null);
  });

  it('saldo trancado: nenhuma chave de aposta aposta; so a wallet do dono tranca e destranca; o saque continua', async () => {
    const chave = Keypair.generate();
    const sessao = sessaoDe(bob.publicKey, chave.publicKey);
    await program.methods.autorizarSessao(chave.publicKey).accountsPartial({ sessao, dono: bob.publicKey }).signers([bob]).rpc();
    const trancar = (v: boolean, k: anchor.web3.Keypair, dono = bob.publicKey) => program.methods.trancarSaldo(v)
      .accountsPartial({ cofre: cofreDe(dono), dono: k.publicKey }).signers([k]).rpc();
    await falha(trancar(true, alice), 'NaoAutorizado'); // a Alice nao tranca o cofre do Bob
    await falha(trancar(true, chave), 'NaoAutorizado'); // nem a chave de aposta
    await trancar(true, bob);
    expect((await cofre(bob.publicKey)).trancado).to.equal(true);

    await program.methods.criarPartida(new BN(6), USDC(1), [alice.publicKey], [bob.publicKey]).accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
    const entrar = () => program.methods.entrarPartidaSessao(USDC(1))
      .accountsPartial({ partida: partidaDe(6), cofre: cofreDe(bob.publicKey), sessao, chave: chave.publicKey }).signers([chave]).rpc();
    await falha(entrar(), 'SaldoTrancado');
    await sacar(bob, USDC(1)); // trancado nao prende o dinheiro
    await falha(trancar(false, chave), 'NaoAutorizado'); // so a wallet destranca
    await trancar(false, bob);
    await entrar();
    expect((await cofre(bob.publicKey)).travado.toString()).to.equal(USDC(1).toString());
  });

  it('tetos de deposito (so para testes/beta): por cofre e total; 0 = sem teto; saque e apostas nunca barrados', async () => {
    const atual = await program.account.config.fetch(config);
    expect(atual.tetoSaldo.toNumber()).to.equal(0); // nasce sem teto
    const tetos = (porCofre: number | null, total: number | null) => program.methods
      .atualizarConfig(null, null, null, null, null, porCofre === null ? null : USDC(porCofre), total === null ? null : USDC(total)).accountsPartial({ config }).rpc();
    await falha(program.methods.atualizarConfig(null, null, null, null, null, USDC(1), null).accountsPartial({ config, admin: alice.publicKey })
      .signers([alice]).rpc(), 'NaoAutorizado'); // so o admin
    const cAlice = await cofre(alice.publicKey);
    const temAlice = (cAlice.saldo.toNumber() + cAlice.travado.toNumber()) / 1e6;
    await tetos(temAlice + 2, null);
    await falha(depositar(alice, USDC(3)), 'AcimaDoTetoDeSaldo');
    await depositar(alice, USDC(2)); // ate o teto, ok
    const total = (await program.account.config.fetch(config)).totalNoCofre.toNumber() / 1e6;
    await tetos(0, total + 1); // sem teto por cofre; teto total logo acima do que ja esta guardado
    await falha(depositar(bob, USDC(2)), 'CofreCheio');
    await depositar(bob, USDC(1));
    await sacar(bob, USDC(1)); // saque nunca e barrado; e libera espaco no total
    expect((await program.account.config.fetch(config)).totalNoCofre.toNumber() / 1e6).to.be.closeTo(total, 1e-6);
    await tetos(0, 0); // sem teto de novo
    await depositar(bob, USDC(5));
  });

  it('taxa da partida 2x2: 5% do pote; cada vencedor recebe igual; o admin muda a taxa (0 = sem taxa)', async () => {
    const [e, f, g, h] = [0, 1, 2, 3].map(() => Keypair.generate());
    for (const k of [e, f, g, h]) {
      await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed');
      ata[k.publicKey.toBase58()] = await createAssociatedTokenAccount(conn, pagador, moeda, k.publicKey);
      await mintTo(conn, pagador, moeda, ata[k.publicKey.toBase58()], pagador, 20_000_000);
      await program.methods.abrirCofre().accountsPartial({ dono: k.publicKey, moeda }).signers([k]).rpc();
      await depositar(k, USDC(20));
    }
    const ordem = [e, f, g, h].map((k) => k.publicKey);
    const saldos = async () => Promise.all(ordem.map(async (k) => (await cofre(k)).saldo.toNumber()));
    const jogar = async (id: number, aposta: number, resultado: number, contas: ReturnType<typeof pares>) => {
      // Saldos antes de travar as apostas: o resultado mostra o efeito da partida inteira (perdedor -aposta, vencedor +aposta - taxa)
      const antes = { s: await saldos(), t: await usdc(taxasUsdc), cfg: (await program.account.config.fetch(config)).totalNoCofre.toNumber() };
      await program.methods.criarPartida(new BN(id), USDC(aposta), [e.publicKey, f.publicKey], [g.publicKey, h.publicKey])
        .accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
      for (const k of [e, f, g, h]) await program.methods.entrarPartida().accountsPartial({ partida: partidaDe(id), jogador: k.publicKey }).signers([k]).rpc();
      await program.methods.liquidarPartida(resultado, null).accountsPartial({ partida: partidaDe(id), arbitro: arbitro.publicKey, pagador: arbitro.publicKey })
        .remainingAccounts(contas).signers([arbitro]).rpc();
      const s = await saldos();
      return { d: s.map((v, i) => v - antes.s[i]!), t: (await usdc(taxasUsdc)) - antes.t,
        cfg: antes.cfg - (await program.account.config.fetch(config)).totalNoCofre.toNumber() };
    };
    // Pote de 12 (4 x 3): taxa de 0,60; cada vencedor ganha 3 - 0,30
    const r1 = await jogar(30, 3, 2, comTaxas(ordem));
    expect(r1.d).to.deep.equal([-3_000_000, -3_000_000, 2_700_000, 2_700_000]);
    expect(r1.t).to.equal(600_000);
    expect(r1.cfg).to.equal(600_000);
    // O admin sobe para o teto (10% do pote): pote de 8, taxa de 0,80
    await program.methods.atualizarConfig(null, null, 1000, null, null, null, null).accountsPartial({ config }).rpc();
    const r2 = await jogar(31, 2, 1, comTaxas(ordem));
    expect(r2.d).to.deep.equal([1_600_000, 1_600_000, -2_000_000, -2_000_000]);
    expect(r2.t).to.equal(800_000);
    // Sem taxa (0): a conta de taxas nao vai, e o vencedor leva o pote inteiro
    await program.methods.atualizarConfig(null, null, 0, null, null, null, null).accountsPartial({ config }).rpc();
    await program.methods.criarPartida(new BN(32), USDC(1), [e.publicKey, f.publicKey], [g.publicKey, h.publicKey])
      .accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
    for (const k of [e, f, g, h]) await program.methods.entrarPartida().accountsPartial({ partida: partidaDe(32), jogador: k.publicKey }).signers([k]).rpc();
    await falha(program.methods.liquidarPartida(1, null).accountsPartial({ partida: partidaDe(32), arbitro: arbitro.publicKey, pagador: arbitro.publicKey })
      .remainingAccounts(comTaxas(ordem)).signers([arbitro]).rpc(), 'ContasInvalidas');
    const antesT = await usdc(taxasUsdc);
    await program.methods.liquidarPartida(1, null).accountsPartial({ partida: partidaDe(32), arbitro: arbitro.publicKey, pagador: arbitro.publicKey })
      .remainingAccounts(pares(ordem)).signers([arbitro]).rpc();
    expect(await usdc(taxasUsdc)).to.equal(antesT);
    expect((await cofre(e.publicKey)).saldo.toNumber()).to.equal(20_000_000 - 3_000_000 + 1_600_000 + 1_000_000);
    // De volta aos 5%: valor quebrado arredonda a taxa para baixo (pote de 2,000006: taxa de 0,1000003 -> 0,100000)
    await program.methods.atualizarConfig(null, null, 500, null, null, null, null).accountsPartial({ config }).rpc();
    const r4 = await jogar(33, 0.500001, 1, comTaxas(ordem));
    expect(r4.t).to.equal(2 * 50_000); // cada par: 2 x 500.001 x 5% = 50.000,1 -> 50.000
    expect(r4.d).to.deep.equal([450_001, 450_001, -500_001, -500_001]);
  });

  it('compra na plataforma: so a wallet do dono, so do saldo livre, so para a carteira de taxas, ate 100 USDC, nunca pausado', async () => {
    const comprar = (k: anchor.web3.Keypair, valor: BN, extra: Record<string, Chave> = {}) => program.methods.comprar(valor, new BN(7))
      .accountsPartial({ dono: k.publicKey, destinoTaxas: taxasUsdc, ...extra }).signers([k]).rpc();
    const foto = async () => ({
      saldo: (await cofre(alice.publicKey)).saldo.toNumber(), tokens: await usdc(tokensDe(alice.publicKey)), t: await usdc(taxasUsdc),
      total: (await program.account.config.fetch(config)).totalNoCofre.toNumber(),
    });
    const antes = await foto();
    await comprar(alice, USDC(2));
    const depois = await foto();
    expect(antes.saldo - depois.saldo).to.equal(2_000_000);
    expect(antes.tokens - depois.tokens).to.equal(2_000_000);
    expect(depois.t - antes.t).to.equal(2_000_000);
    expect(antes.total - depois.total).to.equal(2_000_000);

    // Desvios: so a carteira de taxas recebe (nem outra conta, nem a propria conta do jogador)
    await falha(comprar(alice, USDC(1), { destinoTaxas: ata[carol.publicKey.toBase58()] }), 'CarteiraDeTaxasErrada');
    await falha(comprar(alice, USDC(1), { destinoTaxas: ata[alice.publicKey.toBase58()] }), 'CarteiraDeTaxasErrada');
    // Outro assinando com o cofre da Alice; a chave de aposta da Alice no lugar da wallet
    await falha(program.methods.comprar(USDC(1), new BN(7)).accountsPartial({ dono: bob.publicKey, cofre: cofreDe(alice.publicKey),
      tokens: tokensDe(alice.publicKey), destinoTaxas: taxasUsdc }).signers([bob]).rpc(), 'NaoAutorizado');
    const chave = Keypair.generate();
    await program.methods.autorizarSessao(chave.publicKey).accountsPartial({ sessao: sessaoDe(alice.publicKey, chave.publicKey), dono: alice.publicKey }).signers([alice]).rpc();
    await falha(program.methods.comprar(USDC(1), new BN(7)).accountsPartial({ dono: chave.publicKey, cofre: cofreDe(alice.publicKey),
      tokens: tokensDe(alice.publicKey), destinoTaxas: taxasUsdc }).signers([chave]).rpc(), 'NaoAutorizado');
    // Sem a assinatura da Alice (so a carteira do teste assina e paga)
    const ix = await program.methods.comprar(USDC(1), new BN(7)).accountsPartial({ dono: alice.publicKey, destinoTaxas: taxasUsdc }).instruction();
    ix.keys.forEach((k) => { if (k.pubkey.equals(alice.publicKey)) k.isSigner = false; });
    await falha(provider.sendAndConfirm(new anchor.web3.Transaction().add(ix)), 'NaoAutorizado');
    // Teto fixo por compra
    await falha(comprar(alice, new BN(100_000_001)), 'CompraAcimaDoTeto');
    await falha(comprar(alice, new BN(0)), 'ValorInvalido');
    // So o saldo livre: com aposta travada, nao compra alem do livre
    await program.methods.criarPartida(new BN(40), USDC(3), [alice.publicKey], [bob.publicKey]).accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
    await program.methods.entrarPartida().accountsPartial({ partida: partidaDe(40), jogador: alice.publicKey }).signers([alice]).rpc();
    const livre = (await cofre(alice.publicKey)).saldo.toNumber();
    await falha(comprar(alice, new BN(livre + 1)), 'SaldoInsuficiente');
    await program.methods.cancelarPartida().accountsPartial({ partida: partidaDe(40), quem: arbitro.publicKey, pagador: arbitro.publicKey })
      .remainingAccounts([{ pubkey: cofreDe(alice.publicKey), isSigner: false, isWritable: true }]).signers([arbitro]).rpc();
    // Pausado: nao compra (o saque continua)
    await program.methods.atualizarConfig(null, null, null, null, true, null, null).accountsPartial({ config }).rpc();
    await falha(comprar(alice, USDC(1)), 'Pausado');
    await sacar(alice, USDC(1));
    await program.methods.atualizarConfig(null, null, null, null, false, null, null).accountsPartial({ config }).rpc();
  });

  it('troca de admin em duas etapas', async () => {
    const novo = Keypair.generate();
    await program.methods.proporAdmin(novo.publicKey).accountsPartial({ config }).rpc();
    await falha(program.methods.aceitarAdmin().accountsPartial({ config, novoAdmin: alice.publicKey }).signers([alice]).rpc(), 'NaoAutorizado');
    await program.methods.aceitarAdmin().accountsPartial({ config, novoAdmin: novo.publicKey }).signers([novo]).rpc();
    expect((await program.account.config.fetch(config)).admin.toBase58()).to.equal(novo.publicKey.toBase58());
  });

  it('pool de abandono: quem abandona nao recebe; o que receberia vai para a carteira de taxas; os outros recebem igual', async () => {
    const taxaConta = { pubkey: taxasUsdc, isSigner: false, isWritable: true };
    const liquidar = (id: number, resultado: number, abandonos: number | null, extra: { pubkey: Chave; isSigner: boolean; isWritable: boolean }[] = [taxaConta]) =>
      program.methods.liquidarPartida(resultado, abandonos).accountsPartial({ partida: partidaDe(id), arbitro: arbitro.publicKey, pagador: arbitro.publicKey })
        .remainingAccounts([...pares([alice.publicKey, bob.publicKey]), ...extra]).signers([arbitro]).rpc();
    const nova = async (id: number, aposta: number) => {
      await program.methods.criarPartida(new BN(id), USDC(aposta), [alice.publicKey], [bob.publicKey]).accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc();
      for (const k of [alice, bob]) await program.methods.entrarPartida().accountsPartial({ partida: partidaDe(id), jogador: k.publicKey }).signers([k]).rpc();
    };
    const foto = async () => ({
      a: (await cofre(alice.publicKey)).saldo.toNumber(), b: (await cofre(bob.publicKey)).saldo.toNumber(), t: await usdc(taxasUsdc),
      tokens: (await usdc(tokensDe(alice.publicKey))) + (await usdc(tokensDe(bob.publicKey))),
      total: (await program.account.config.fetch(config)).totalNoCofre.toNumber(),
    });

    // 1. Alice (time A) abandona e o time A vence: ela nao recebe nada; a carteira de taxas recebe as duas apostas (a taxa
    //    de 5% do pote + a pool, que e o que ela receberia: 2 x 2 - 0,20); Bob perde como sempre
    const antes1 = await foto();
    await nova(20, 2);
    await falha(liquidar(20, 1, 0b01, []), 'ContasInvalidas'); // sem a conta da carteira de taxas
    await falha(liquidar(20, 1, 0b01, [{ ...taxaConta, pubkey: ata[carol.publicKey.toBase58()] }]), 'CarteiraDeTaxasErrada'); // desviar para outro
    await falha(liquidar(20, 1, 0b100), 'AbandonoInvalido'); // quem nao esta na partida
    await falha(liquidar(20, 1, 0b11), 'AbandonoInvalido'); // todos abandonaram
    await liquidar(20, 1, 0b01);
    const depois1 = await foto();
    expect(depois1.a - antes1.a).to.equal(-2_000_000); // perdeu a propria aposta (nao recebeu nada)
    expect(depois1.b - antes1.b).to.equal(-2_000_000); // perdeu a aposta, como em qualquer derrota
    expect(depois1.t - antes1.t).to.equal(4_000_000); // pool: a aposta dela + o premio
    expect(antes1.tokens - depois1.tokens).to.equal(4_000_000); // os tokens acompanham a contabilidade
    expect(antes1.total - depois1.total).to.equal(4_000_000); // saiu do programa

    // 2. Empate com abandono do Bob: Alice recebe a dela de volta; a aposta do Bob vai para a pool
    const antes2 = await foto();
    await nova(21, 1);
    await liquidar(21, 0, 0b10);
    const depois2 = await foto();
    expect(depois2.a - antes2.a).to.equal(0);
    expect(depois2.b - antes2.b).to.equal(-1_000_000);
    expect(depois2.t - antes2.t).to.equal(1_000_000);

    // 3. Bob abandona e o time dele perde: igual a uma derrota normal (Alice ganha 1 - 5% do pote de 2); a pool nao recebe nada, so a taxa sai
    const antes3 = await foto();
    await nova(22, 1);
    await liquidar(22, 1, 0b10);
    const depois3 = await foto();
    expect(depois3.a - antes3.a).to.equal(900_000);
    expect(depois3.b - antes3.b).to.equal(-1_000_000);
    expect(depois3.t - antes3.t).to.equal(100_000); // so a taxa
    expect(antes3.tokens - depois3.tokens).to.equal(100_000);
    expect(antes3.total - depois3.total).to.equal(100_000);
  });
});
