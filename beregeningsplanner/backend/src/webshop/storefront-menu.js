// Menu van de webshop: submenu's klappen naar rechts open en alleen naar links als er rechts geen
// ruimte meer is in het scherm. Zonder dit script klapt alles naar rechts (de CSS-standaard).

/**
 * Zet een uitklapper (bij aanwijzen of focus al zichtbaar) naar links als hij rechts buiten het scherm valt.
 * @param {HTMLElement} list De uitklaplijst (`.nav-drop`).
 * @returns {void}
 */
function fitDropdown(list) {
  list.classList.remove('fly-left', 'drop-left');
  const box = list.getBoundingClientRect();
  if (box.width === 0 || box.right <= document.documentElement.clientWidth) return;
  list.classList.add(list.classList.contains('nav-fly') ? 'fly-left' : 'drop-left');
}

/**
 * Past bij het aanwijzen van een menu-onderdeel de uitklappers eronder aan.
 * @param {Event} event De mouseover- of focusin-gebeurtenis.
 * @returns {void}
 */
function onMenuEnter(event) {
  const item = event.target.closest('.nav-group, .nav-all, .has-sub');
  if (!item) return;
  const list = item.querySelector(':scope > .nav-drop');
  if (!list) return;
  fitDropdown(list);
  // Een submenu in een naar links geklapt menu klapt ook naar links; anders eerst naar rechts.
  for (const nested of list.querySelectorAll('.nav-fly')) nested.classList.toggle('fly-left', list.classList.contains('fly-left') || list.classList.contains('drop-left'));
}

/**
 * Past bij een schermwijziging de uitklappers die open blijven (door focus) opnieuw aan.
 * @returns {void}
 */
function onResize() {
  for (const list of document.querySelectorAll('.nav-group:focus-within > .nav-drop, .nav-all:focus-within > .nav-drop, .has-sub:focus-within > .nav-drop')) fitDropdown(list);
}

window.addEventListener('resize', onResize);
document.addEventListener('mouseover', onMenuEnter);
document.addEventListener('focusin', onMenuEnter);
