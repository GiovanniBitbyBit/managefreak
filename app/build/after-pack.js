// ManageFreak — hook di electron-builder: firma ad-hoc del bundle macOS.
//
// Senza un certificato Apple Developer, electron-builder non firma nulla: salta
// completamente la firma. Su macOS — e in particolare su Apple Silicon — un'app
// non firmata nemmeno ad-hoc non viene semplicemente "avvisata": viene rifiutata
// con "ManageFreak is damaged and should be moved to the Trash", un messaggio da
// cui non si esce con "tasto destro → Apri".
//
// La firma ad-hoc (`codesign --sign -`) non richiede alcun certificato ed è
// quella che macOS accetta sempre. Cambia il blocco da "danneggiata" a
// "sviluppatore non identificato", che il workaround documentato nel README
// risolve davvero.
//
// Questo hook gira DOPO il packaging dell'app e PRIMA che vengano creati il dmg
// e lo zip, quindi la firma finisce dentro entrambi.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return; // solo macOS

  const appName = context.packager.appInfo.productFilename; // "ManageFreak"
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  // Se la firma non è valida la build deve fallire qui, non arrivare all'utente
  // sotto forma di "app danneggiata".
  console.log('  • verifying the signature');
  execFileSync('codesign', ['--verify', '--deep', '--verbose=2', appPath], { stdio: 'inherit' });
  console.log('  • macOS bundle signed ad-hoc');
};
