const {Menu, dialog, nativeImage, clipboard, ClipboardItem} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');

async function showImageMenu(window, payload, {registry, source}) {
  const {image, filename, language} = payload || {};
  if (typeof image !== 'string' || image.length > 48 * 1024 * 1024 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image) ||
      typeof filename !== 'string' || filename.length > 500 || !['ko','en'].includes(language))
    throw Error('Invalid image export request.');
  const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
  if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    throw Error('Invalid PNG image.');
  const bitmap = nativeImage.createFromBuffer(bytes);
  const size = bitmap.getSize();
  if (bitmap.isEmpty() || size.width * size.height > 32_000_000)
    throw Error('Invalid image dimensions.');
  const identity = await registry.resolve(source);
  const name = ((identity.patientId || identity.uuid) + '_' + filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.png$/i, '').slice(0,200).replace(/[. ]+$/, '') || 'EXMO-image';
  const en = language === 'en';
  const choice = await new Promise(resolve => {
    let selected = null;
    const menu = Menu.buildFromTemplate([
      {label: en ? 'Save image as PNG…' : '이미지를 PNG로 저장…', click: () => {selected='save';}},
      {label: en ? 'Copy image' : '이미지 복사', click: () => {selected='copy';}},
      {type:'separator'},
      {label: en ? 'Export identifier mapping (CSV)…' : '식별자 매핑표 내보내기 (CSV)…', click: () => {selected='mapping';}},
    ]);
    menu.popup({window, callback: () => resolve(selected)});
  });
  if (choice === 'copy') {
    await clipboard.write([new ClipboardItem({'image/png': new Blob([bytes], {type:'image/png'})})]);
    await registry.recordExport(identity, source, {action:'copy',filename:'',sha256:createHash('sha256').update(bytes).digest('hex')});
    return {action:'copy'};
  }
  if (choice === 'save') {
    const selection = await dialog.showSaveDialog(window, {
      title: en ? 'Save image as PNG' : '이미지를 PNG로 저장',
      defaultPath: name + '.png', filters:[{name:'PNG',extensions:['png']}],
    });
    if (!selection.canceled && selection.filePath) {
      await fs.writeFile(selection.filePath, bytes);
      await registry.recordExport(identity, source, {action:'save',filename:path.basename(selection.filePath),sha256:createHash('sha256').update(bytes).digest('hex')});
      return {action:'save'};
    }
  }
  if (choice === 'mapping') {
    const selection = await dialog.showSaveDialog(window, {
      title: en ? 'Export identifier mapping' : '식별자 매핑표 내보내기',
      defaultPath:'EXMO-identifier-mapping.csv', filters:[{name:'CSV',extensions:['csv']}],
    });
    if (!selection.canceled && selection.filePath) {
      await fs.writeFile(selection.filePath, await registry.csv(), 'utf8');
      return {action:'mapping'};
    }
  }
  return {action:'cancel'};
}
module.exports = {showImageMenu};
