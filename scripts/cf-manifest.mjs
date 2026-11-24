import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, extname, relative } from 'node:path'
const root = process.argv[2]
const out = {}
const walk = d => {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p)
    else {
      const buf = readFileSync(p)
      const ext = extname(p).slice(1)
      const hash = createHash('sha256').update(buf.toString('base64') + ext).digest('hex').slice(0, 32)
      out['/' + relative(root, p)] = { hash, size: buf.length }
    }
  }
}
walk(root)
console.log(JSON.stringify(out))
