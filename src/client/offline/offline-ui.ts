import { answerFork } from './sync';

// Lightweight DOM-driven offline status banner + fork prompt.
// These listen to the custom events the sync engine dispatches, so the
// collaboration UI stays decoupled from Datastar signals.

export function setupOfflineUI(): void {
  const banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.className = 'offline-banner';
  // Default connectivity is offline, so show the banner immediately. The
  // connectivity listener will hide it the moment a probe succeeds.
  banner.style.display = 'block';
  banner.textContent = 'Offline — edits are stored locally';
  document.body.appendChild(banner);

  syncStatusListener(banner);
  connectivityBannerListener(banner);

  // Fork prompt modal
  const modal = document.createElement('div');
  modal.id = 'fork-modal';
  modal.className = 'modal-overlay fork-overlay';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>Conflicting changes detected</h3>
      </div>
      <div class="modal-body">
        <p>This room changed on the server while you were editing offline. To avoid a merge conflict, you can fork your work into a brand-new room.</p>
      </div>
      <div class="modal-footer">
        <button class="landing-btn secondary" data-fork-cancel>Keep working offline</button>
        <button class="landing-btn primary" data-fork-confirm>Fork into new room</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let pendingRoom: string | null = null;

  function showFork(roomId: string): void {
    pendingRoom = roomId;
    modal.style.display = 'flex';
  }
  function hideFork(): void {
    modal.style.display = 'none';
    pendingRoom = null;
  }

  modal.querySelector('[data-fork-confirm]')?.addEventListener('click', () => {
    // answerFork resolves the engine's dangling promise; forkRoom is invoked
    // by the engine itself when the user chooses to fork.
    answerFork(true);
    hideFork();
  });
  modal.querySelector('[data-fork-cancel]')?.addEventListener('click', () => {
    answerFork(false);
    hideFork();
  });

  window.addEventListener('excalidraw:fork-prompt', ((e: CustomEvent) => {
    showFork(e.detail.roomId);
  }) as EventListener);

  window.addEventListener('excalidraw:forked', ((e: CustomEvent) => {
    // Navigate to the new room.
    const { newRoomId } = e.detail;
    if (newRoomId) {
      location.href = `/d/${newRoomId}`;
    }
  }) as EventListener);
}

// Drive the banner directly from connectivity (covers the default-offline boot,
// where the sync engine has nothing to emit yet).
function connectivityBannerListener(banner: HTMLElement): void {
  window.addEventListener('excalidraw:connectivity', ((e: CustomEvent) => {
    const online = !!e.detail.online;
    if (!online) {
      banner.textContent = 'Offline — edits are stored locally';
      banner.className = 'offline-banner';
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }) as EventListener);
}

function syncStatusListener(banner: HTMLElement): void {
  window.addEventListener('excalidraw:sync-status', ((e: CustomEvent) => {
    const { kind, message } = e.detail;
    if (kind === 'offline') {
      banner.textContent = message || 'Offline';
      banner.className = 'offline-banner';
      banner.style.display = 'block';
    } else if (kind === 'syncing') {
      banner.textContent = message || 'Syncing…';
      banner.className = 'offline-banner syncing';
      banner.style.display = 'block';
    } else if (kind === 'warning') {
      banner.textContent = message || 'Conflict';
      banner.className = 'offline-banner warning';
      banner.style.display = 'block';
    } else if (kind === 'online') {
      banner.style.display = 'none';
    }
  }) as EventListener);
}

