
import sniff from '../../util/sniff'
import glob from '../../promised/glob'
import fs from '../../promised/fs'

/**
 * Tries to find executables by sniffing file contents,
 * +x them, and return a list of them
 */
function fix_execs (base_path) {
  return (
    glob(`${base_path}/**/*`, {nodir: true})
    .map(sniff_and_chmod, {concurrency: 4})
    .filter((x) => !!x)
  )
}

async function sniff_and_chmod (file) {
  if (await sniff.path(file)) {
    await fs.chmodAsync(file, 0o777)
    return file
  }
}

export default {fix_execs}
