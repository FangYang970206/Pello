const { restore } = require('./node-pty-pack.cjs')

exports.default = async function afterPack() {
  restore()
}
