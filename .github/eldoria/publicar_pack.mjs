// Roda na GitHub Action do repositório do launcher (eldoria-cobblemon/eldoria-launcher), não no PC do dono.
// Zipa o resourcepack do main da Angela com a mesma regra do publicador, sobe o zip na Release fixa "resourcepack"
// (o pack passou de 100 MB, limite de arquivo dentro do repo; Release aceita até 2 GB e não conta banda do Pages),
// troca SÓ a entrada dele no manifesto, sobe o seq e assina. Mods, Java, Fabric, notícias etc. continuam vindo do "npm run publicar" do dono.
//
//   node .github/eldoria/publicar_pack.mjs <pasta do pack> <commit>   -> publica o pack desse commit
//   node .github/eldoria/publicar_pack.mjs --sem-pack                 -> só reassina (teste do segredo/push/Pages)
//   node .github/eldoria/publicar_pack.mjs conferir                   -> espera o Pages servir o manifesto novo
//                                                                        e apaga zips velhos da Release (fica o anterior)
//
// Chave privada: variável ELDORIA_CHAVE_PRIVADA (segredo do repositório). Nunca é impressa nem gravada em disco.
// Fonte deste arquivo: eldoria_launcher/publicador/acao/ (o "npm run enviar" copia pra .github/eldoria/).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { zipDePasta, ignorarPack } from './zip.mjs'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const RAIZ = process.cwd()                       // raiz do repositório do launcher (= publicado/)
const NOME = process.env.ELDORIA_PACK_NOME || 'ELDORIA COBBLEMON.zip'
const REPO = process.env.GITHUB_REPOSITORY || 'eldoria-cobblemon/eldoria-launcher'
const TAG = 'resourcepack'                       // Release fixa só com os zips do pack
const LIMITE = 1900 * 1048576                    // asset de Release: até 2 GB
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()

const log = (...a) => console.log(...a)
const hashArquivo = (arq) => crypto.createHash('sha256').update(fs.readFileSync(arq)).digest('hex')
const CHAVE_PUBLICA_B64 = fs.readFileSync(path.join(AQUI, 'chave_publica.txt'), 'utf8').trim()
const publica = crypto.createPublicKey({ key: Buffer.from(CHAVE_PUBLICA_B64, 'base64'), format: 'der', type: 'spki' })

function lerManifesto() {
    const corpo = fs.readFileSync(path.join(RAIZ, 'manifest.json'))
    const sig = fs.readFileSync(path.join(RAIZ, 'manifest.json.sig'), 'utf8').trim()
    // Só assina por cima de um manifesto que já é nosso.
    if (!crypto.verify(null, corpo, publica, Buffer.from(sig, 'base64'))) throw new Error('manifest.json atual com assinatura inválida. Nada foi publicado.')
    return JSON.parse(corpo.toString('utf8'))
}

function carregarChave() {
    const pem = process.env.ELDORIA_CHAVE_PRIVADA
    if (!pem) throw new Error('Falta o segredo ELDORIA_CHAVE_PRIVADA no repositório.')
    const privada = crypto.createPrivateKey(pem)
    const par = crypto.createPublicKey(privada).export({ type: 'spki', format: 'der' }).toString('base64')
    if (par !== CHAVE_PUBLICA_B64) throw new Error('O segredo ELDORIA_CHAVE_PRIVADA não é par da chave pública do launcher.')
    return privada
}

// Apaga um arquivo hospedado e as pastas que ficarem vazias (um por um, nada recursivo).
function removerHospedado(rel) {
    let abs = path.join(RAIZ, ...rel.split('/'))
    if (!fs.existsSync(abs)) return
    fs.unlinkSync(abs)
    for (let i = 0; i < 2; i++) {
        abs = path.dirname(abs)
        if (fs.readdirSync(abs).length) break
        fs.rmdirSync(abs)
    }
}

function publicar(pastaPack, commit) {
    const m = lerManifesto()
    const privada = carregarChave()

    if (pastaPack) {
        const i = m.arquivos.findIndex((a) => a.caminho === 'resourcepacks/' + NOME)
        if (i < 0) throw new Error(`O manifesto não tem resourcepacks/${NOME}`)
        const antigo = m.arquivos[i]
        const tmp = path.join(os.tmpdir(), 'pack.zip')
        const n = zipDePasta(pastaPack, tmp, ignorarPack)
        const sha256 = hashArquivo(tmp)
        const size = fs.statSync(tmp).size
        log(`${NOME}: ${n} arquivos, ${(size / 1048576).toFixed(1)} MB, commit ${commit.slice(0, 7)}`)
        if (size > LIMITE) throw new Error(`O pack zipado tem ${(size / 1048576).toFixed(1)} MB, acima do limite da Release.`)

        if (sha256 === antigo.sha256) {
            log('  conteúdo igual ao já publicado (só registra o commit)')
        } else {
            // nome do asset sem espaço (o GitHub troca espaço por ponto); no PC do jogador continua "ELDORIA COBBLEMON.zip"
            const asset = `${NOME.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-')}-${sha256.slice(0, 12)}.zip`
            const comNome = path.join(os.tmpdir(), asset)
            fs.renameSync(tmp, comNome)
            try { gh('release', 'view', TAG, '--repo', REPO, '--json', 'tagName') } catch {
                gh('release', 'create', TAG, '--repo', REPO, '--latest=false', '--title', 'Resourcepack (automático)',
                    '--notes', 'Zips do resourcepack publicados pela GitHub Action. Não é o instalador: baixe o launcher na Release mais recente.')
            }
            gh('release', 'upload', TAG, comNome, '--repo', REPO, '--clobber')
            fs.renameSync(comNome, tmp)
            // zip antigo hospedado no Pages (antes da Release) sai do repositório
            const corte = antigo.url.indexOf('/arquivos/')
            if (corte >= 0 && !m.arquivos.some((a, j) => j !== i && a.url === antigo.url)) removerHospedado(decodeURIComponent(antigo.url.slice(corte + 1)))
            m.arquivos[i] = { ...antigo, url: `https://github.com/${REPO}/releases/download/${TAG}/${asset}`, sha256, size }
            log(`  na Release: ${asset}`)
        }
        fs.unlinkSync(tmp)
        m.resourcepackCommit = commit
    }

    m.seq += 1
    m.publicadoEm = new Date().toISOString()
    const corpo = Buffer.from(JSON.stringify(m, null, 1), 'utf8')
    const assinatura = crypto.sign(null, corpo, privada).toString('base64')
    if (!crypto.verify(null, corpo, publica, Buffer.from(assinatura, 'base64'))) throw new Error('Falha ao conferir a assinatura')
    fs.writeFileSync(path.join(RAIZ, 'manifest.json.sig'), assinatura)
    fs.writeFileSync(path.join(RAIZ, 'manifest.json'), corpo)
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `seq=${m.seq}\n`)
    log(`Publicação #${m.seq} assinada.`)
}

// Espera o GitHub Pages servir o manifesto novo e confere a assinatura e o pack no ar.
async function conferir() {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'manifest.json'), 'utf8'))
    const pack = m.arquivos.find((a) => a.caminho === 'resourcepacks/' + NOME)
    const [dono, nome] = REPO.split('/')
    const base = `https://${dono.toLowerCase()}.github.io/${nome}/`
    const baixar = async (url) => { const r = await fetch(url + '?v=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`); return Buffer.from(await r.arrayBuffer()) }
    const local = fs.readFileSync(path.join(RAIZ, 'manifest.json'))
    let noAr = null
    for (let i = 0; i < 60; i++) {
        try { noAr = await baixar(base + 'manifest.json') } catch { noAr = null }
        if (noAr && noAr.equals(local)) break
        await new Promise((r) => setTimeout(r, 5000))
    }
    if (!noAr || !noAr.equals(local)) throw new Error('O GitHub Pages não publicou o manifesto novo em 5 minutos.')
    const sig = await baixar(base + 'manifest.json.sig')
    if (!sig.equals(fs.readFileSync(path.join(RAIZ, 'manifest.json.sig')))) throw new Error('Assinatura no ar diferente da publicada')
    const b = await baixar(pack.url)
    if (crypto.createHash('sha256').update(b).digest('hex') !== pack.sha256) throw new Error('Pack no ar diferente do manifesto')
    log(`OK no ar: publicação #${m.seq}, ${NOME} conferido.`)

    // Limpeza da Release: fica o zip atual e o anterior (jogador no meio do download ainda termina).
    let assets = []
    try { assets = JSON.parse(gh('release', 'view', TAG, '--repo', REPO, '--json', 'assets')).assets } catch { /* Release ainda não existe */ }
    assets.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    const atual = path.basename(new URL(pack.url).pathname)
    let anterior = null
    for (const a of assets) {
        if (a.name === atual) continue
        if (!anterior) { anterior = a.name; continue }
        gh('release', 'delete-asset', TAG, a.name, '--repo', REPO, '--yes')
        log(`  zip velho apagado da Release: ${a.name}`)
    }
}

const args = process.argv.slice(2)
try {
    if (args[0] === 'conferir') await conferir()
    else if (args[0] === '--sem-pack') publicar(null, null)
    else {
        const [pasta, commit] = args
        if (!pasta || !fs.existsSync(path.join(pasta, 'pack.mcmeta'))) throw new Error('Pasta do pack inválida (sem pack.mcmeta): ' + pasta)
        if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('Commit inválido: ' + commit)
        publicar(pasta, commit)
    }
} catch (e) {
    console.error('::error::' + e.message)
    process.exit(1)
}
