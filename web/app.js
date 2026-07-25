/**
 * Vanilla JS for the read-only demo page. No build step, no CDN — everything here has to run
 * from a plain `<script src>` tag served by src/query/serve.ts's static file handler.
 */

/** Renders a fetched attestation list into `container`, or the "nobody is currently vouching"
 * empty state. That wording is deliberate — see index.html's footer and the README's
 * "mechanism mismatch": an empty result means nobody is refreshing that attestation right
 * now, not that the strategy closed, and not that something went wrong. */
function renderStrategies(container, strategies, emptyMessage) {
  container.innerHTML = '';
  if (strategies.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = emptyMessage;
    container.appendChild(div);
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = `
    <caption>${strategies.length} live attestation${strategies.length === 1 ? '' : 's'}</caption>
    <thead>
      <tr>
        <th scope="col">Maker</th>
        <th scope="col">App</th>
        <th scope="col">Tokens (committed)</th>
        <th scope="col">Coverage</th>
        <th scope="col">Status</th>
        <th scope="col">Last block</th>
        <th scope="col">Attested at</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  for (const s of strategies) {
    const tr = document.createElement('tr');

    const committedList = s.tokens
      .map((t) => `${t}: ${s.committed[t] ?? '0'}`)
      .join('\n');

    const attestedAt = new Date(s.attestedAt * 1000).toISOString();
    const statusLabel = s.underfunded ? 'Underfunded' : 'Covered';
    const badgeClass = s.underfunded ? 'badge badge-underfunded' : 'badge badge-ok';

    tr.innerHTML = `
      <td>${s.maker}</td>
      <td>${s.app}</td>
      <td><pre>${committedList}</pre></td>
      <td>${s.coverageRatio ?? 'n/a'}</td>
      <td><span class="${badgeClass}">${statusLabel}</span></td>
      <td>${s.lastBlock}</td>
      <td>${attestedAt}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderError(container, message) {
  container.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'error-state';
  div.textContent = message;
  container.appendChild(div);
}

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body && body.error ? body.error : `Request failed (${res.status}).`);
  }
  return body;
}

function wireForm(formId, resultId, buildUrl, emptyMessage) {
  const form = document.getElementById(formId);
  const result = document.getElementById(resultId);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const params = new FormData(form);
    result.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'section-note';
    loading.textContent = 'Loading…';
    result.appendChild(loading);
    try {
      const strategies = await fetchJson(buildUrl(params));
      renderStrategies(result, strategies, emptyMessage);
    } catch (err) {
      renderError(result, err.message);
    }
  });
}

wireForm(
  'pair-form',
  'pair-result',
  (params) =>
    `/api/strategies?tokenA=${encodeURIComponent(params.get('tokenA'))}&tokenB=${encodeURIComponent(
      params.get('tokenB'),
    )}`,
  'Nobody is currently vouching for a strategy on this pair.',
);

wireForm(
  'maker-form',
  'maker-result',
  (params) => `/api/maker?maker=${encodeURIComponent(params.get('maker'))}`,
  'Nobody is currently vouching for a strategy from this maker.',
);

document.getElementById('underfunded-refresh').addEventListener('click', async () => {
  const result = document.getElementById('underfunded-result');
  result.innerHTML = '';
  const loading = document.createElement('p');
  loading.className = 'section-note';
  loading.textContent = 'Loading…';
  result.appendChild(loading);
  try {
    const strategies = await fetchJson('/api/underfunded');
    renderStrategies(result, strategies, 'No makers are currently flagged underfunded.');
  } catch (err) {
    renderError(result, err.message);
  }
});
