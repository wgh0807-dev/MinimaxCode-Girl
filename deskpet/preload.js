'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  onState(cb) {
    ipcRenderer.on('pet:state', (_e, payload) => cb(payload));
  },
  onPoke(cb) {
    ipcRenderer.on('pet:poke', () => cb());
  },
  hover(hovering) {
    ipcRenderer.send('pet:hover', !!hovering);
  },
  dragStart() {
    ipcRenderer.send('pet:drag:start');
  },
  dragEnd() {
    ipcRenderer.send('pet:drag:end');
  },
  menu() {
    ipcRenderer.send('pet:menu');
  }
});