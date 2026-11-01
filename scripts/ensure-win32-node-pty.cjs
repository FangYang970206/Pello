const { ensure } = require('./node-pty-pack.cjs')

exports.default = async function beforePack(context) {
  ensure(context)
}
