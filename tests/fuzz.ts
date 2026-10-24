// Teste de ataque aleatorio ("fuzzing") do cofre: sorteia centenas de operacoes, validas e maliciosas, e depois de
// CADA uma confere as regras que nunca podem quebrar:
//  1. o saldo de cada cofre (livre + travado) e exatamente o que esta na conta de tokens dele;
//  2. nada some nem aparece: soma dos cofres = depositado - sacado - taxas das partidas - compras; a carteira de
//     taxas tem exatamente as taxas cobradas + as compras (saque nao tem taxa);
//  3. o travado de cada jogador = soma das apostas das partidas abertas em que ele entrou;
//  4. o total guardado na configuracao (tetos) = depositado - sacado - taxas;
//  5. liquidacao paga certo: vencedor +2x aposta - taxa do par (bps das duas apostas), empate devolve, perdedor nada;
//  6. todo ataque falha (sacar do cofre de outro, apostar no cofre de outro, arbitro falso, chave revogada, desviar
//     a taxa da partida ou liquidar sem ela...).
// Rodar: FUZZ=1 PASSOS=400 SEMENTE=7 npm test (scripts/testar.sh). Reproduzivel pela SEMENTE.
import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { createAssociatedTokenAccount, createMint, getAccount, mintTo } from '@solana/spl-token';
import { expect } from 'chai';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync('idl/cofre.json', 'utf8'));
const { Keypair, PublicKey, LAMPORTS_PER_SOL } = anchor.web3;
type Chave = anchor.web3.PublicKey;
type Par = anchor.web3.Keypair;
const PASSOS = Number(process.env.PASSOS ?? 300);
const SEMENTE = Number(process.env.SEMENTE ?? 7);
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

// Sorteio reproduzivel (mulberry32)
let estadoRng = SEMENTE >>> 0;
const rng = (): number => {
  estadoRng = (estadoRng + 0x6d2b79f5) >>> 0;
  let t = estadoRng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const sorteia = <T>(lista: T[]): T | undefined => lista[Math.floor(rng() * lista.length)];
const inteiro = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

describe('cofre: ataque aleatorio (fuzzing)', function () {
  this.timeout(0);
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as anchor.Idl, provider);
  const conn = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const arbitro = Keypair.generate();
  const taxas = Keypair.generate();
  const atacante = Keypair.generate();
  const jogadores: Par[] = Array.from({ length: 4 }, () => Keypair.generate());
  const todos = [...jogadores, atacante];
  let moeda: Chave; let taxasUsdc: Chave;
  const ata = new Map<string, Chave>();
  const sessoes = new Map<string, Par[]>(); // chaves de aposta autorizadas (e nao revogadas) de cada um
  const revogadas: Array<{ dono: Par; chave: Par }> = [];
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
  const pda = (...s: Buffer[]) => PublicKey.findProgramAddressSync(s, program.programId)[0];
  const cofreDe = (k: Chave) => pda(Buffer.from('cofre'), k.toBuffer());
  const tokensDe = (k: Chave) => pda(Buffer.from('tokens'), k.toBuffer());
  const sessaoDe = (d: Chave, c: Chave) => pda(Buffer.from('sessao'), d.toBuffer(), c.toBuffer());
  const partidaDe = (id: number) => pda(Buffer.from('partida'), new BN(id).toArrayLike(Buffer, 'le', 8));
  const nome = (k: Par) => (k === atacante ? 'atacante' : 'j' + jogadores.indexOf(k));
  const id58 = (k: Par) => k.publicKey.toBase58();

  // Modelo: o que o teste sabe que aconteceu (so atualiza quando a operacao deu certo)
  let depositado = 0n;
  let sacado = 0n;
  let taxasCobradas = 0n;
  let compras = 0n; // compras na plataforma (cosmeticos), pagas do saldo livre para a carteira de taxas
  let bps = 500n; // taxa das partidas (pontos-base do pote)
  const taxaDoPar = (aposta: bigint) => (2n * aposta * bps) / 10_000n;
  interface PartidaModelo { id: number; a: Par[]; b: Par[]; aposta: bigint; entrou: Set<string>; aberta: boolean }
  const partidas: PartidaModelo[] = [];
  let proximoId = 1;
  const contagem = { ok: 0, recusadas: 0, ataques: 0 };
  const abertas = () => partidas.filter((x) => x.aberta);

  async function tentar(p: Promise<unknown>): Promise<boolean> {
    try { await p; contagem.ok++; return true; } catch { contagem.recusadas++; return false; }
  }
  async function deveFalhar(descricao: string, p: Promise<unknown>): Promise<void> {
    contagem.ataques++;
    let passou = false;
    try { await p; passou = true; } catch { /* esperado */ }
    expect(passou, 'ATAQUE PASSOU: ' + descricao).to.equal(false);
  }
  const usdc = async (c: Chave): Promise<bigint> => { try { return (await getAccount(conn, c)).amount; } catch { return 0n; } };
  async function cofre(k: Chave): Promise<{ saldo: bigint; travado: bigint } | null> {
    const i = await conn.getAccountInfo(cofreDe(k));
    if (!i) return null;
    return { saldo: i.data.readBigUInt64LE(40), travado: i.data.readBigUInt64LE(48) };
  }

  async function conferirInvariantes(passo: number, op: string): Promise<void> {
    const onde = 'passo ' + passo + ' (' + op + '): ';
    let soma = 0n;
    for (const k of todos) {
      const c = await cofre(k.publicKey);
      if (!c) continue;
      expect(await usdc(tokensDe(k.publicKey)), onde + 'tokens de ' + nome(k) + ' != saldo + travado').to.equal(c.saldo + c.travado);
      soma += c.saldo + c.travado;
      const travadoModelo = abertas().filter((p) => p.entrou.has(id58(k))).reduce((s, p) => s + p.aposta, 0n);
      expect(c.travado, onde + 'travado de ' + nome(k) + ' diferente das apostas abertas').to.equal(travadoModelo);
    }
    expect(soma, onde + 'dinheiro sumiu ou apareceu').to.equal(depositado - sacado - taxasCobradas - compras);
    expect(await usdc(taxasUsdc), onde + 'carteira de taxas diferente das taxas + compras').to.equal(taxasCobradas + compras);
    const cfg = await program.account.config.fetch(config);
    expect(BigInt(cfg.totalNoCofre.toString()), onde + 'total do cofre na configuracao').to.equal(depositado - sacado - taxasCobradas - compras);
    expect(BigInt(cfg.taxaPartidaBps), onde + 'taxa na configuracao').to.equal(bps);
  }

  before(async () => {
    for (const k of [arbitro, ...todos]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
    moeda = await createMint(conn, admin, admin.publicKey, null, 6);
    for (const k of todos) {
      const c = await createAssociatedTokenAccount(conn, admin, moeda, k.publicKey);
      ata.set(id58(k), c);
      await mintTo(conn, admin, moeda, c, admin, 1_000_000_000); // 1000 USDC
      sessoes.set(id58(k), []);
    }
    taxasUsdc = await createAssociatedTokenAccount(conn, admin, moeda, taxas.publicKey);
    const [dadosPrograma] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], LOADER);
    await program.methods.inicializar(arbitro.publicKey, taxas.publicKey, 500, new BN(50_000_000))
      .accounts({ admin: admin.publicKey, dadosPrograma, moeda }).rpc();
    for (const k of todos) await program.methods.abrirCofre().accountsPartial({ dono: k.publicKey, moeda }).signers([k]).rpc();
  });

  it(PASSOS + ' operacoes aleatorias (semente ' + SEMENTE + ') sem quebrar nenhuma regra', async () => {
    for (let passo = 1; passo <= PASSOS; passo++) {
      const r = rng();
      let op = '';
      const k = sorteia(jogadores)!;
      const kid = id58(k);
      if (r < 0.16) {
        op = 'depositar';
        const valor = BigInt(sorteia([0, 1, inteiro(1, 40), inteiro(1, 200), 2000])! * 1_000_000);
        const ok = await tentar(program.methods.depositar(new BN(valor.toString()))
          .accountsPartial({ dono: k.publicKey, origem: ata.get(kid)!, config }).signers([k]).rpc());
        if (ok) depositado += valor;
      } else if (r < 0.20) {
        op = 'comprar';
        const c = await cofre(k.publicKey);
        const saldo = c ? c.saldo : 0n;
        const valor = sorteia([1_000_000n, saldo, saldo + 1n, 0n, 100_000_001n, 5_000_000n])!;
        const ok = await tentar(program.methods.comprar(new BN(valor.toString()), new BN(passo))
          .accountsPartial({ dono: k.publicKey, destinoTaxas: taxasUsdc, config }).signers([k]).rpc());
        if (ok) {
          expect(valor > 0n && valor <= 100_000_000n && valor <= saldo, 'passo ' + passo + ': compra de ' + valor + ' aceita com saldo ' + saldo).to.equal(true);
          compras += valor;
        }
      } else if (r < 0.26) {
        op = 'sacar';
        const c = await cofre(k.publicKey);
        const saldo = c ? c.saldo : 0n;
        const valor = sorteia([saldo, saldo / 2n, saldo + 1n, 0n, 1_000_000n])!;
        const ok = await tentar(program.methods.sacar(new BN(valor.toString()))
          .accountsPartial({ dono: k.publicKey, destino: ata.get(kid)!, config }).signers([k]).rpc());
        if (ok) sacado += valor;
      } else if (r < 0.32) {
        op = 'autorizar chave';
        const chave = Keypair.generate();
        const ok = await tentar(program.methods.autorizarSessao(chave.publicKey)
          .accountsPartial({ sessao: sessaoDe(k.publicKey, chave.publicKey), dono: k.publicKey }).signers([k]).rpc());
        if (ok) sessoes.get(kid)!.push(chave);
      } else if (r < 0.35) {
        op = 'revogar chave';
        const lista = sessoes.get(kid)!;
        if (lista.length) {
          const chave = lista.splice(Math.floor(rng() * lista.length), 1)[0]!;
          const quem = rng() < 0.5 ? k : chave;
          const ok = await tentar(program.methods.revogarSessao()
            .accountsPartial({ sessao: sessaoDe(k.publicKey, chave.publicKey), dono: k.publicKey, quem: quem.publicKey }).signers([quem]).rpc());
          if (ok) revogadas.push({ dono: k, chave }); else lista.push(chave);
        }
      } else if (r < 0.39) {
        op = 'trancar/destrancar';
        await tentar(program.methods.trancarSaldo(rng() < 0.5).accountsPartial({ cofre: cofreDe(k.publicKey), dono: k.publicKey }).signers([k]).rpc());
      } else if (r < 0.50) {
        op = 'criar partida';
        const porTime = sorteia([1, 1, 2])!;
        const mistura = [...jogadores].sort(() => rng() - 0.5);
        const a = mistura.slice(0, porTime);
        const b = mistura.slice(porTime, 2 * porTime);
        const aposta = BigInt(sorteia([1, 2, 5, 10, 60])! * 1_000_000); // 60 passa do teto de 50: deve falhar
        const id = proximoId++;
        const ok = await tentar(program.methods.criarPartida(new BN(id), new BN(aposta.toString()), a.map((x) => x.publicKey), b.map((x) => x.publicKey))
          .accounts({ arbitro: arbitro.publicKey }).signers([arbitro]).rpc());
        if (ok) partidas.push({ id, a, b, aposta, entrou: new Set(), aberta: true });
      } else if (r < 0.66) {
        op = 'entrar na partida';
        const p = sorteia(abertas());
        if (p) {
          const j = sorteia([...p.a, ...p.b])!;
          const lista = sessoes.get(id58(j))!;
          let ok: boolean;
          if (rng() < 0.6 && lista.length) {
            // As vezes a chave que assina nao e a da sessao informada: tem de falhar
            const sessao = sorteia(lista)!;
            const chave = sorteia(lista)!;
            ok = await tentar(program.methods.entrarPartidaSessao(new BN(p.aposta.toString())).accountsPartial({
              partida: partidaDe(p.id), cofre: cofreDe(j.publicKey), sessao: sessaoDe(j.publicKey, sessao.publicKey), chave: chave.publicKey,
            }).signers([chave]).rpc());
            if (ok) expect(chave, 'passo ' + passo + ': entrou com chave diferente da sessao').to.equal(sessao);
          } else {
            ok = await tentar(program.methods.entrarPartida().accountsPartial({ partida: partidaDe(p.id), jogador: j.publicKey }).signers([j]).rpc());
          }
          if (ok) p.entrou.add(id58(j));
        }
      } else if (r < 0.76) {
        op = 'liquidar';
        const p = sorteia(abertas());
        if (p) {
          const resultado = sorteia([0, 1, 2])!;
          const ordem = [...p.a, ...p.b];
          const antes = await Promise.all(ordem.map((x) => cofre(x.publicKey)));
          const contas = ordem.flatMap((x) => [cofreDe(x.publicKey), tokensDe(x.publicKey)]).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
          const taxa = resultado === 0 ? 0n : taxaDoPar(p.aposta);
          if (taxa > 0n) contas.push({ pubkey: taxasUsdc, isSigner: false, isWritable: true });
          const ok = await tentar(program.methods.liquidarPartida(resultado, null)
            .accountsPartial({ partida: partidaDe(p.id), arbitro: arbitro.publicKey, pagador: arbitro.publicKey })
            .remainingAccounts(contas).signers([arbitro]).rpc());
          if (ok) {
            expect(p.entrou.size, 'passo ' + passo + ': liquidou partida que nao estava travada por todos').to.equal(ordem.length);
            p.aberta = false;
            taxasCobradas += taxa * BigInt(p.a.length);
            const depois = await Promise.all(ordem.map((x) => cofre(x.publicKey)));
            ordem.forEach((x, i) => {
              const doA = i < p.a.length;
              const ganho = resultado === 0 ? p.aposta : (resultado === 1) === doA ? 2n * p.aposta - taxa : 0n;
              expect(depois[i]!.saldo - antes[i]!.saldo, 'passo ' + passo + ': pagamento errado para ' + nome(x)).to.equal(ganho);
            });
          }
        }
      } else if (r < 0.82) {
        op = 'cancelar';
        const p = sorteia(abertas());
        if (p) {
          const entraram = [...p.a, ...p.b].filter((x) => p.entrou.has(id58(x)));
          const ok = await tentar(program.methods.cancelarPartida()
            .accountsPartial({ partida: partidaDe(p.id), quem: arbitro.publicKey, pagador: arbitro.publicKey })
            .remainingAccounts(entraram.map((x) => ({ pubkey: cofreDe(x.publicKey), isSigner: false, isWritable: true }))).signers([arbitro]).rpc());
          if (ok) p.aberta = false;
        }
      } else if (r < 0.86) {
        op = 'mudar tetos e taxa';
        const porCofre = sorteia([0, 0, 100, 300])!;
        const total = sorteia([0, 0, 2000, 5000])!;
        const novaTaxa = sorteia([500, 500, 0, 1000, 1001])!; // 1001 passa do teto: deve falhar
        const ok = await tentar(program.methods.atualizarConfig(null, null, novaTaxa, null, null, new BN(porCofre * 1_000_000), new BN(total * 1_000_000))
          .accountsPartial({ config }).rpc());
        expect(ok, 'passo ' + passo + ': taxa ' + novaTaxa + ' aceita/recusada errado').to.equal(novaTaxa <= 1000);
        if (ok) bps = BigInt(novaTaxa);
      } else {
        // ---------- Ataques: todos tem de falhar ----------
        const vitima = sorteia(jogadores)!;
        const tipo = inteiro(0, 10);
        op = 'ataque ' + tipo;
        if (tipo === 0) {
          await deveFalhar('sacar do cofre de outro para a propria conta', program.methods.sacar(new BN(1_000_000)).accountsPartial({
            dono: atacante.publicKey, cofre: cofreDe(vitima.publicKey), tokens: tokensDe(vitima.publicKey),
            destino: ata.get(id58(atacante))!, config,
          }).signers([atacante]).rpc());
        } else if (tipo === 1) {
          // A instrucao diz que o dono e a vitima, mas quem assina e o atacante (a vitima nao assina)
          const ix = await program.methods.sacar(new BN(1_000_000)).accountsPartial({
            dono: vitima.publicKey, destino: ata.get(id58(vitima))!, config,
          }).instruction();
          ix.keys.forEach((x) => { if (x.pubkey.equals(vitima.publicKey)) x.isSigner = false; });
          await deveFalhar('sacar do cofre de outro sem a assinatura dele', provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [atacante]));
        } else if (tipo === 2) {
          const p = sorteia(abertas());
          if (p) {
            const minha = Keypair.generate();
            await tentar(program.methods.autorizarSessao(minha.publicKey)
              .accountsPartial({ sessao: sessaoDe(atacante.publicKey, minha.publicKey), dono: atacante.publicKey }).signers([atacante]).rpc());
            const alvo = sorteia([...p.a, ...p.b])!;
            await deveFalhar('apostar no cofre de outro com a propria chave', program.methods.entrarPartidaSessao(new BN(p.aposta.toString())).accountsPartial({
              partida: partidaDe(p.id), cofre: cofreDe(alvo.publicKey), sessao: sessaoDe(atacante.publicKey, minha.publicKey), chave: minha.publicKey,
            }).signers([minha]).rpc());
          }
        } else if (tipo === 3) {
          const p = sorteia(abertas());
          if (p) {
            const contas = [...p.a, ...p.b].flatMap((x) => [cofreDe(x.publicKey), tokensDe(x.publicKey)]).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
            await deveFalhar('liquidar como arbitro falso', program.methods.liquidarPartida(1, null)
              .accountsPartial({ partida: partidaDe(p.id), arbitro: atacante.publicKey, pagador: arbitro.publicKey })
              .remainingAccounts(contas).signers([atacante]).rpc());
          }
        } else if (tipo === 4) {
          const rev = sorteia(revogadas);
          const p = rev ? abertas().find((x) => [...x.a, ...x.b].includes(rev.dono) && !x.entrou.has(id58(rev.dono))) : undefined;
          if (rev && p) {
            await deveFalhar('apostar com chave revogada', program.methods.entrarPartidaSessao(new BN(p.aposta.toString())).accountsPartial({
              partida: partidaDe(p.id), cofre: cofreDe(rev.dono.publicKey), sessao: sessaoDe(rev.dono.publicKey, rev.chave.publicKey), chave: rev.chave.publicKey,
            }).signers([rev.chave]).rpc());
          }
        } else if (tipo === 5) {
          await deveFalhar('depositar com a conta de USDC de outro', program.methods.depositar(new BN(1_000_000)).accountsPartial({
            dono: atacante.publicKey, origem: ata.get(id58(vitima))!, config,
          }).signers([atacante]).rpc());
        } else if (tipo === 7 || tipo === 8) {
          // Liquidacao com vencedor feita pelo arbitro de verdade, mas desviando a taxa (para o atacante ou para o
          // proprio vencedor) ou sem a conta da carteira de taxas: tem de falhar
          const p = abertas().find((x) => x.entrou.size === x.a.length + x.b.length);
          if (p && bps > 0n) {
            const contas = [...p.a, ...p.b].flatMap((x) => [cofreDe(x.publicKey), tokensDe(x.publicKey)]).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
            if (tipo === 7) contas.push({ pubkey: sorteia([ata.get(id58(atacante))!, tokensDe(p.a[0]!.publicKey), ata.get(id58(p.a[0]!))!])!, isSigner: false, isWritable: true });
            await deveFalhar(tipo === 7 ? 'desviar a taxa da partida' : 'liquidar com vencedor sem a conta de taxas', program.methods.liquidarPartida(1, null)
              .accountsPartial({ partida: partidaDe(p.id), arbitro: arbitro.publicKey, pagador: arbitro.publicKey })
              .remainingAccounts(contas).signers([arbitro]).rpc());
          }
        } else if (tipo === 9) {
          await deveFalhar('comprar com o cofre de outro', program.methods.comprar(new BN(1_000_000), new BN(passo)).accountsPartial({
            dono: atacante.publicKey, cofre: cofreDe(vitima.publicKey), tokens: tokensDe(vitima.publicKey), destinoTaxas: taxasUsdc, config,
          }).signers([atacante]).rpc());
        } else if (tipo === 10) {
          await deveFalhar('compra mandando o dinheiro para outra conta', program.methods.comprar(new BN(1_000_000), new BN(passo)).accountsPartial({
            dono: vitima.publicKey, destinoTaxas: ata.get(id58(atacante))!, config,
          }).signers([vitima]).rpc());
        } else {
          await deveFalhar('trancar/destrancar o saldo de outro', program.methods.trancarSaldo(false)
            .accountsPartial({ cofre: cofreDe(vitima.publicKey), dono: atacante.publicKey }).signers([atacante]).rpc());
        }
      }
      await conferirInvariantes(passo, op);
    }
    console.log('      ' + PASSOS + ' passos: ' + contagem.ok + ' operacoes aceitas, ' + contagem.recusadas + ' recusadas pelo contrato, '
      + contagem.ataques + ' ataques (todos falharam)');
  });
});
