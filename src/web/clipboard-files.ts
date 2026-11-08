/** FileList and items describe the same clipboard payload; never enqueue both. */
export function clipboardFiles(data: Pick<DataTransfer, 'files' | 'items'>): File[] {
  const files = Array.from(data.files);
  return files.length
    ? files
    : Array.from(data.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
}
