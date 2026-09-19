'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // Password visibility toggle
  const togglePasswordBtn = document.getElementById('toggle-password');
  const passwordInput = document.getElementById('password');

  if (togglePasswordBtn && passwordInput) {
    togglePasswordBtn.addEventListener('click', () => {
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';

      togglePasswordBtn.innerHTML = isPassword
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    });
  }

  // Form submission
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      loginError.hidden = true;
      submitBtn.disabled = true;
      const originalText = submitBtn.innerHTML;
      submitBtn.innerHTML = '<div class="splash-spinner" style="width:20px;height:20px;border-width:2px;border-top-color:white;margin:auto;"></div>';

      const username = document.getElementById('username').value;
      const password = passwordInput.value;

      try {
        const response = await fetch('/api/admin/login-books', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (data.authenticated && data.roles.includes('books')) {
          submitBtn.innerHTML = '<span>ACCESS GRANTED</span>';
          submitBtn.style.background = '#10B981'; // green
          setTimeout(() => {
            window.location.href = '/bills';
          }, 500);
        } else {
          loginError.textContent = data.message || 'Authentication failed. Please check your billing credentials.';
          loginError.hidden = false;
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalText;
        }
      } catch (err) {
        loginError.textContent = 'A network error occurred. Please try again.';
        loginError.hidden = false;
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
      }
    });
  }
});
