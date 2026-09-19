'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // 1. Splash Screen Transition
  const splash = document.getElementById('splash-screen');
  setTimeout(() => {
    if (splash) {
      splash.classList.add('hidden');
    }
  }, 900); // 0.9s delay for splash screen

  // 2. Interactive Live Moving Wave Art (Mouse Parallax)
  const heroCard = document.getElementById('hero-artwork-card');
  const liveWaveImg = document.getElementById('live-wave-image');

  if (heroCard && liveWaveImg && window.matchMedia('(pointer: fine)').matches) {
    let currentX = 0;
    let currentY = 0;
    let targetX = 0;
    let targetY = 0;
    let animationFrameId = null;

    const renderParallax = () => {
      currentX += (targetX - currentX) * 0.08;
      currentY += (targetY - currentY) * 0.08;

      // Apply dynamic subtle transform offset on top of the base CSS animation
      liveWaveImg.style.translate = `${currentX.toFixed(2)}px ${currentY.toFixed(2)}px`;

      if (Math.abs(targetX - currentX) > 0.01 || Math.abs(targetY - currentY) > 0.01) {
        animationFrameId = requestAnimationFrame(renderParallax);
      } else {
        animationFrameId = null;
      }
    };

    window.addEventListener('mousemove', (e) => {
      const { innerWidth, innerHeight } = window;
      const normX = (e.clientX / innerWidth) - 0.5; // -0.5 to 0.5
      const normY = (e.clientY / innerHeight) - 0.5;

      targetX = normX * -18; // Shift up to 18px in opposite direction
      targetY = normY * -18;

      if (!animationFrameId) {
        animationFrameId = requestAnimationFrame(renderParallax);
      }
    }, { passive: true });
  }

  // 3. Password Visibility Toggle
  const togglePasswordBtn = document.getElementById('toggle-password');
  const passwordInput = document.getElementById('password');

  if (togglePasswordBtn && passwordInput) {
    togglePasswordBtn.addEventListener('click', () => {
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';

      togglePasswordBtn.innerHTML = isPassword
        ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>`
        : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>`;
    });
  }

  // 4. Form Submission
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');
  const btnText = document.getElementById('btn-text');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      if (loginError) loginError.hidden = true;
      submitBtn.disabled = true;
      const originalText = btnText ? btnText.textContent : 'Sign In';

      if (btnText) {
        btnText.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:6px;"></span> Signing In...';
      }

      const username = document.getElementById('username')?.value?.trim() || '';
      const password = passwordInput?.value || '';

      try {
        const response = await fetch('/api/admin/login-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (data.authenticated) {
          if (btnText) btnText.textContent = 'Success!';
          submitBtn.style.backgroundColor = '#059669'; // Emerald green
          setTimeout(() => {
            window.location.href = '/dashboard';
          }, 450);
        } else {
          if (loginError) {
            loginError.textContent = data.message || 'Invalid credentials. Please check your email or password.';
            loginError.hidden = false;
          }
          submitBtn.disabled = false;
          if (btnText) btnText.textContent = originalText;
        }
      } catch {
        if (loginError) {
          loginError.textContent = 'A network error occurred. Please check your connection and try again.';
          loginError.hidden = false;
        }
        submitBtn.disabled = false;
        if (btnText) btnText.textContent = originalText;
      }
    });
  }

  // 5. Info Modal for Forgot Password & Sign Up
  const infoModal = document.getElementById('info-modal');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const forgotLink = document.getElementById('forgot-password-link');
  const signupLink = document.getElementById('signup-prompt-link');
  const modalTitle = document.getElementById('modal-title');
  const modalDesc = document.getElementById('modal-desc');

  const showInfo = (title, message) => {
    if (modalTitle) modalTitle.textContent = title;
    if (modalDesc) modalDesc.textContent = message;
    if (infoModal && typeof infoModal.showModal === 'function') {
      infoModal.showModal();
    }
  };

  forgotLink?.addEventListener('click', (e) => {
    e.preventDefault();
    showInfo(
      'Password Recovery',
      'For security purposes, password resets must be authorized by your Voltronix system administrator. Please reach out to your technical lead.'
    );
  });

  signupLink?.addEventListener('click', (e) => {
    e.preventDefault();
    showInfo(
      'Account Registration',
      'Voltronix Automation System is an internal enterprise platform. New administrative and billing accounts are provisioned directly by the IT department.'
    );
  });

  modalCloseBtn?.addEventListener('click', () => {
    if (infoModal && typeof infoModal.close === 'function') {
      infoModal.close();
    }
  });

  infoModal?.addEventListener('click', (e) => {
    if (e.target === infoModal && typeof infoModal.close === 'function') {
      infoModal.close();
    }
  });
});
