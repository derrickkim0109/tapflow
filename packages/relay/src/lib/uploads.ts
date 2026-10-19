import fs from 'fs'

// 업로드 정리: 파일을 삭제하되 이미 없으면(ENOENT) 조용히 넘기고, 그 외 에러만 경고한다.
// builds/comments 업로드 핸들러가 거부·만료된 파일을 정리할 때 공유한다.
export function unlinkSafe(filePath: string, label: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[tapflow] failed to delete ${label}`, (err as Error).message)
    }
  }
}

/**
 * Writes an uploaded file to `dest`. Resolves once it is on disk; on a failed upload or write, closes the
 * writer, removes what was written and rejects.
 *
 * `stream.pipe(writer)` does neither: when busboy destroys a file's stream — a body that ends inside the
 * part — the writer stays open and the partial file stays on disk, once per failed upload.
 *
 * The rejection is marked handled here, for the case where nobody awaits it: a failed part also fails the
 * parser, whose `'error'` handler answers the request, and the route's `'finish'` never runs. A failed
 * *write* (a full disk) is different — the parser still finishes and the route awaits a rejection, so every
 * caller catches it.
 */
export function pipeUpload(stream: NodeJS.ReadableStream, dest: string, label: string): Promise<void> {
  const writer = fs.createWriteStream(dest)
  const written = new Promise<void>((resolve, reject) => {
    let failed = false
    const fail = (err: unknown) => {
      if (failed) return
      failed = true
      // Keep reading the upload: a writer error unpipes it, and a part nobody reads holds the parser short
      // of `'finish'`, so the route would never answer.
      stream.resume()
      // Remove the file once the writer has closed it: Windows refuses to delete an open file, and an error
      // before the open completes would otherwise delete nothing and leave the file it then creates.
      const remove = () => { unlinkSafe(dest, label); reject(err) }
      if (writer.closed) remove()
      else { writer.once('close', remove); writer.destroy() }
    }
    writer.on('finish', resolve)
    writer.on('error', fail)
    stream.on('error', fail)
  })
  written.catch(() => {})
  stream.pipe(writer)
  return written
}
