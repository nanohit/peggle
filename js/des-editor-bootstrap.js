import './main.js';

document.addEventListener('DOMContentLoaded', async () => {
  const app=window.peggleApp;
  const selectionKey='peggle_des_editor_current';
  const savedId=localStorage.getItem(selectionKey);
  if(savedId)app.levelManager.setCurrentLevelById(savedId);
  const save=app.levelManager.save.bind(app.levelManager);
  app.levelManager.save=(...args)=>{const current=app.levelManager.getCurrentLevel();if(current)localStorage.setItem(selectionKey,current.id);return save(...args);};
  let level=null;
  const saved=sessionStorage.getItem('peggle_des_editor_import');
  if(saved){try{level=JSON.parse(saved);}catch{}sessionStorage.removeItem('peggle_des_editor_import');}
  if(!level&&app.levelManager.getCurrentLevel()?.pegs.length===0){
    const response=await fetch(new URL('data/des/campaign.json',document.baseURI));
    if(response.ok)level=(await response.json()).levels[0];
  }
  if(level){
    const imported=app.levelManager.importLevel(JSON.stringify(level));
    if(imported){app.levelManager.setCurrentLevelById(imported.id);app.startEditor();app.updateLevelTitle();app.updateLevelSettings();}
  }
  else if(savedId){app.startEditor();app.updateLevelTitle();app.updateLevelSettings();}
  const link=document.createElement('a');link.href=new URL('/des',location.href).href;link.textContent='← Destruction';link.style.cssText='color:#a5e9ff;font:12px system-ui;margin-right:8px';
  document.querySelector('.header')?.prepend(link);
  window.__aleaDesEditorReady=true;
});
