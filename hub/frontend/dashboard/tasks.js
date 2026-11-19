// Startscherm "Openstaande taken": wat er voor de ingelogde gebruiker nog te doen ligt (api/tasks):
// webshopbestellingen verwerken, bestelvoorstellen goedkeuren. Per taak
// het aantal en een link; bij bestellingen de oudste vijf. Zonder openstaande taken blijft het blok weg.
(function () {
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /**
   * Tekent het blok met de openstaande taken.
   * @param {HTMLElement} container Het element #tasks.
   * @param {{ key: string, title: string, count: number, href: string, items: object[] }[]} tasks De taken uit api/tasks.
   * @returns {void}
   */
  function render(container, tasks) {
    container.innerHTML = `
      <h2>Openstaande taken <span class="tasks-count">${esc(tasks.reduce((sum, task) => sum + task.count, 0))}</span></h2>
      <div class="tasks-grid">${tasks.map((task) => `
        <section class="task" data-task="${esc(task.key)}">
          <a class="task-head" href="${esc(task.href)}"><span class="task-title">${esc(task.title)}</span><span class="task-badge">${esc(task.count)}</span></a>
          ${task.items.length ? `<ul class="task-items">${task.items.map((item) => `
            <li><a href="${esc(item.href)}"><span class="task-label">${esc(item.label)}</span><span class="task-meta">${esc(item.meta)}</span></a></li>`).join('')}</ul>` : ''}
          ${task.command ? `<div class="task-command"><p class="task-meta">Plak dit op de Proxmox-host (als root):</p><pre class="task-code">${esc(task.command)}</pre><button class="btn" type="button" data-copy="${esc(task.key)}">Kopieer commando</button></div>` : ''}
          ${task.count > task.items.length && task.items.length ? `<p class="task-more"><a href="${esc(task.href)}">Alle ${esc(task.count)} bekijken →</a></p>` : ''}
        </section>`).join('')}</div>`;
    container.querySelectorAll('[data-copy]').forEach((button) => {
      const task = tasks.find((candidate) => candidate.key === button.dataset.copy);
      button.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(task.command); button.textContent = 'Gekopieerd'; } catch (error) { button.textContent = 'Selecteer en kopieer de tekst hierboven'; }
      });
    });
    container.hidden = false;
  }

  /**
   * Haalt de openstaande taken op en toont ze.
   * @param {object} me Antwoord van api/me.
   * @returns {Promise<void>}
   */
  async function start(me) {
    const container = document.getElementById('tasks');
    if (!container || !me || !me.user || location.protocol === 'file:') return;
    try {
      const data = window.AquatechCommon ? await window.AquatechCommon.getJson('api/tasks') : await (await fetch('api/tasks', { cache: 'no-store' })).json();
      const tasks = (data && data.tasks) || [];
      if (tasks.length) render(container, tasks);
      else container.hidden = true;
    } catch (error) { /* geen verbinding: het blok blijft weg */ }
  }

  window.AquatechTasks = { start };
})();
