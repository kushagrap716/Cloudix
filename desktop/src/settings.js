'use strict'

const dbInput = document.getElementById('databaseUrl')
const urlInput = document.getElementById('serverUrl')
const errorEl = document.getElementById('error')
const originEl = document.getElementById('origin')
const saveBtn = document.getElementById('save')
const cancelBtn = document.getElementById('cancel')
const builtinChoice = document.getElementById('builtinChoice')
const builtinFields = document.getElementById('builtinFields')
const externalFields = document.getElementById('externalFields')
const radios = Array.from(document.querySelectorAll('input[name=mode]'))
const dbRadios = Array.from(document.querySelectorAll('input[name=database]'))
const customDbFields = document.getElementById('customDbFields')
const embeddedChoice = document.getElementById('embeddedChoice')

function selectedDatabase() {
  const checked = dbRadios.find((r) => r.checked)
  return checked ? checked.value : 'custom'
}

function selectedMode() {
  const checked = radios.find((r) => r.checked)
  return checked ? checked.value : 'external'
}

function refresh() {
  const builtin = selectedMode() === 'builtin'
  builtinFields.classList.toggle('hidden', !builtin)
  externalFields.classList.toggle('hidden', builtin)
  customDbFields.classList.toggle('hidden', selectedDatabase() !== 'custom')
}

radios.forEach((r) => r.addEventListener('change', refresh))
dbRadios.forEach((r) => r.addEventListener('change', refresh))

window.desktopSettings.get().then((data) => {
  if (!data) return
  dbInput.value = data.databaseUrl
  urlInput.value = data.serverUrl
  originEl.textContent = data.appOrigin
  if (!data.builtinAvailable) builtinChoice.classList.add('hidden')
  if (!data.embeddedAvailable) embeddedChoice.classList.add('hidden')
  const mode = data.builtinAvailable ? data.mode : 'external'
  const database = data.embeddedAvailable ? data.database : 'custom'
  radios.forEach((r) => { r.checked = r.value === mode })
  dbRadios.forEach((r) => { r.checked = r.value === database })
  refresh()
  if (mode === 'external') urlInput.focus()
  else if (database === 'custom') dbInput.focus()
})

async function save() {
  errorEl.textContent = ''
  saveBtn.disabled = true
  try {
    const result = await window.desktopSettings.save({
      mode: selectedMode(),
      database: selectedDatabase(),
      databaseUrl: dbInput.value,
      serverUrl: urlInput.value,
    })
    if (result && !result.ok) errorEl.textContent = result.error || 'Could not save.'
  } catch {
    // The window closes itself after a successful save, which can interrupt this call.
  } finally {
    saveBtn.disabled = false
  }
}

saveBtn.addEventListener('click', save)
cancelBtn.addEventListener('click', () => window.desktopSettings.cancel())
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.desktopSettings.cancel()
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'text') save()
})
