// Distribuição cifrada: tudo que NÓS hospedamos (Pages e Releases: mods nossos, resourcepack, configs) vai pro ar em
// AES-256-GCM. Quem pegar o link do manifest.json baixa só bytes sem sentido; só o launcher tem a chave pra abrir.
// (Modrinth, Mojang, Fabric e Java continuam em claro: são públicos de qualquer jeito.)
//
// Formato: "ASD1" + iv(12) + cifrado + tag(16). O iv sai do sha256 do arquivo em claro (HMAC com a chave), então o
// mesmo arquivo cifra sempre igual: republicar não troca nada no ar.
//
// Chave: ~/.eldoria-launcher/chave_cifra.bin (PC do dono) ou ASTREA_CHAVE_CIFRA em base64 (segredo da GitHub Action).
// A mesma chave vai embutida no launcher (src/main/chave_cifra.js, gerado por "publicar.mjs gerar-chave-cifra").
// Usado pelo publicar.mjs e pela Action (o "npm run enviar" copia este arquivo pra .github/astrea/).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const MAGIA = Buffer.from('ASD1')
export const ARQ_CHAVE = path.join(os.homedir(), '.eldoria-launcher', 'chave_cifra.bin')

export function lerChave() {
    let chave
    if (process.env.ASTREA_CHAVE_CIFRA) chave = Buffer.from(process.env.ASTREA_CHAVE_CIFRA.trim(), 'base64')
    else if (fs.existsSync(ARQ_CHAVE)) chave = fs.readFileSync(ARQ_CHAVE)
    else throw new Error('Sem chave de cifra (ASTREA_CHAVE_CIFRA ou ' + ARQ_CHAVE + '). No PC: node publicador/publicar.mjs gerar-chave-cifra')
    if (chave.length !== 32) throw new Error('Chave de cifra com tamanho errado')
    return chave
}

// Nome opaco e fixo pro arquivo no ar (não entrega o nome do mod nem o hash em claro).
export function nomeOpaco(chave, sha256) {
    return crypto.createHmac('sha256', chave).update('nome:' + sha256).digest('hex').slice(0, 24)
}

export function cifrarBuffer(chave, dados) {
    const sha256 = crypto.createHash('sha256').update(dados).digest('hex')
    const iv = crypto.createHmac('sha256', chave).update('iv:' + sha256).digest().subarray(0, 12)
    const c = crypto.createCipheriv('aes-256-gcm', chave, iv)
    const saida = Buffer.concat([MAGIA, iv, c.update(dados), c.final(), c.getAuthTag()])
    return { saida, sha256, cifrado: { sha256: crypto.createHash('sha256').update(saida).digest('hex'), size: saida.length } }
}

export function decifrarBuffer(chave, b) {
    if (!b.subarray(0, 4).equals(MAGIA)) throw new Error('Arquivo cifrado inválido')
    const d = crypto.createDecipheriv('aes-256-gcm', chave, b.subarray(4, 16))
    d.setAuthTag(b.subarray(b.length - 16))
    return Buffer.concat([d.update(b.subarray(16, b.length - 16)), d.final()])
}

// Cifra <origem> em <destino>. Devolve { sha256 (em claro), size (em claro), cifrado: { sha256, size } }.
export function cifrarArquivo(chave, origem, destino) {
    const dados = fs.readFileSync(origem)
    const r = cifrarBuffer(chave, dados)
    fs.mkdirSync(path.dirname(destino), { recursive: true })
    fs.writeFileSync(destino, r.saida)
    return { sha256: r.sha256, size: dados.length, cifrado: r.cifrado }
}
