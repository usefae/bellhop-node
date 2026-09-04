#!/usr/bin/env node
import { main } from './cli-main.js'

main(process.argv.slice(2), process.env, { out: console.log, err: console.error }).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`\n  ${(error as Error).message}\n`)
    process.exitCode = 1
  }
)
