export function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

export function openPrintWindow(htmlContent) {
  const printWindow = window.open('', '_blank', 'width=800,height=600')
  printWindow.document.open()
  printWindow.document.write(htmlContent)
  printWindow.document.close()
  setTimeout(() => printWindow.print(), 500)
}
