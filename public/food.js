'use strict';
// Food runs: one person starts a group order in DoorDash / Uber Eats / etc.,
// pastes its share link here, and everyone in the room gets a card to add their
// own food and say when they've ordered. (Delivery apps don't let other apps
// place orders, but their group orders do exactly this job.)
//
// Uses globals from app.js: socket, myId, $, toast, openPanel, panelOpen,
// activeTab, addSystemMessage.

const food = { run: null, timer: null };

const FOOD_STATUS_TEXT = { in: "I'm in", ordered: 'Ordered ✓', out: 'Not this time' };

function myFoodStatus() {
  return food.run?.statuses?.[myId]?.status || null;
}

function renderFood() {
  const run = food.run;
  $('#foodStart').hidden = !!run;
  $('#foodRun').hidden = !run;
  // Badge on the footer button until you've answered.
  $('#foodBadge').hidden = !run || !!myFoodStatus();
  $('#foodBtn').classList.toggle('active', !!run);
  if (!run) return;

  $('#foodHeadline').textContent = run.byId === myId
    ? `You started a ${run.service} group order.`
    : `${run.by} started a ${run.service} group order.`;
  $('#foodOpen').href = run.url;
  $('#foodOpen').textContent = `Add my order on ${run.service} ↗`;
  renderDeadline();

  const mine = myFoodStatus();
  document.querySelectorAll('#foodRun [data-status]').forEach((b) => {
    b.classList.toggle('active', b.dataset.status === mine);
    b.setAttribute('aria-pressed', String(b.dataset.status === mine));
  });

  const list = $('#foodPeople');
  list.replaceChildren();
  const entries = Object.entries(run.statuses);
  const order = { ordered: 0, in: 1, out: 2 };
  entries.sort((a, b) => order[a[1].status] - order[b[1].status]);
  entries.forEach(([id, { name, status }]) => {
    const li = document.createElement('li');
    li.className = `food-person ${status}`;
    const n = document.createElement('span');
    n.textContent = id === myId ? `${name} (you)` : name;
    const st = document.createElement('span');
    st.className = 'food-person-status';
    st.textContent = FOOD_STATUS_TEXT[status];
    li.append(n, st);
    list.appendChild(li);
  });
  const waiting = typeof peers !== 'undefined'
    ? [...peers.entries()].filter(([id]) => !run.statuses[id]).map(([, p]) => p.name)
    : [];
  if (waiting.length) {
    const li = document.createElement('li');
    li.className = 'food-person waiting';
    li.textContent = `Not answered yet: ${waiting.join(', ')}`;
    list.appendChild(li);
  }
}

function renderDeadline() {
  const run = food.run;
  if (!run) return;
  const el = $('#foodDeadlineText');
  if (run.deadline.at) {
    const left = run.deadline.at - Date.now();
    el.textContent = left > 0
      ? `Order in the next ${Math.ceil(left / 60000)} min`
      : 'Time’s up! Whoever started it can check out now.';
    el.classList.toggle('late', left <= 0);
  } else {
    el.textContent = run.deadline.key === 'none' ? 'Add your order whenever you’re ready.' : `Order ${run.deadline.label}.`;
    el.classList.remove('late');
  }
}
setInterval(renderDeadline, 15000);

// ---------- From the server ----------
function applyFood(run) {
  food.run = run;
  renderFood();
}

socket.on('joined', ({ food: run }) => applyFood(run || null));

socket.on('food-state', ({ run, event, by }) => {
  applyFood(run);
  if (event === 'started') {
    const mine = run?.byId === myId;
    addSystemMessage(mine ? `🍕 You started a ${run.service} group order` : `🍕 ${by} started a ${run.service} group order: open Food to add yours`);
    if (!mine) toast(`🍕 ${by} is ordering ${run.service}. Tap Food to add yours.`);
  } else if (event === 'ended') {
    addSystemMessage(`🍕 ${by} closed the food run`);
  }
});

socket.on('food-error', ({ message }) => {
  $('#foodError').textContent = message;
});

// ---------- Your actions ----------
$('#foodForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#foodError').textContent = '';
  socket.emit('food-start', { url: $('#foodUrl').value.trim(), deadline: $('#foodDeadline').value });
});

document.querySelectorAll('#foodRun [data-status]').forEach((b) => {
  b.onclick = () => socket.emit('food-status', { status: b.dataset.status });
});

// Opening the order counts as "I'm in" if you hadn't said anything yet.
$('#foodOpen').addEventListener('click', () => {
  if (!myFoodStatus()) socket.emit('food-status', { status: 'in' });
});

$('#foodEnd').onclick = () => {
  if (confirmEnd()) socket.emit('food-end');
};
function confirmEnd() {
  const btn = $('#foodEnd');
  if (btn.dataset.confirm) { delete btn.dataset.confirm; btn.textContent = 'End food run'; return true; }
  btn.dataset.confirm = '1';
  btn.textContent = 'Tap again to end it for everyone';
  setTimeout(() => { delete btn.dataset.confirm; btn.textContent = 'End food run'; }, 4000);
  return false;
}

$('#foodBtn').onclick = () => (panelOpen() && activeTab === 'food' ? closePanel() : openPanel('food'));
function onFoodTabOpened() { renderFood(); }
