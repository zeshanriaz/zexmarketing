// ZexMarketing site scripts

document.addEventListener('DOMContentLoaded', () => {
  // Mobile menu toggle
  const toggle = document.querySelector('.menu-toggle');
  const menu = document.querySelector('.nav-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      menu.classList.toggle('open');
      const expanded = menu.classList.contains('open');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
    menu.querySelectorAll('a:not(.has-dropdown > a)').forEach(link => {
      link.addEventListener('click', () => menu.classList.remove('open'));
    });
  }

  // FAQ accordion
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const wasOpen = item.classList.contains('open');
      item.parentElement.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  // Contact form handling (works for the hero quick form and the full contact page form)
  const form = document.getElementById('contactForm');
  if (form) {
    const notice = form.querySelector('.form-notice');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const name = (data.get('name') || '').toString().trim();
      const email = (data.get('email') || '').toString().trim();
      const phoneField = form.querySelector('[name="phone"]');
      const phone = (data.get('phone') || '').toString().trim();
      const messageField = form.querySelector('textarea[name="message"]');
      const message = (data.get('message') || '').toString().trim();
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      const phoneRequired = phoneField && phoneField.required;
      const phoneOk = !phoneRequired || /^[+()\-\s\d]{7,}$/.test(phone);
      const messageRequired = messageField && messageField.required;
      const messageOk = !messageRequired || message.length > 0;

      if (!name || !emailOk || !phoneOk || !messageOk) {
        notice.className = 'form-notice error';
        const missing = [];
        if (!name) missing.push('name');
        if (!emailOk) missing.push('a valid email');
        if (!phoneOk) missing.push('a valid phone');
        if (!messageOk) missing.push('a message');
        notice.textContent = `Please provide ${missing.join(', ')}.`;
        return;
      }
      notice.className = 'form-notice success';
      notice.textContent = `Thanks, ${name.split(' ')[0]}! Your request has been received. A senior strategist will reply within one business day.`;
      form.reset();
    });
  }

  // Newsletter form handling
  document.querySelectorAll('.footer-newsletter').forEach(nl => {
    nl.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = nl.querySelector('input[type="email"]');
      const btn = nl.querySelector('button');
      const email = (input.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        btn.textContent = 'Invalid email';
        setTimeout(() => (btn.textContent = 'Subscribe'), 1800);
        return;
      }
      btn.textContent = 'Subscribed ✓';
      input.value = '';
      setTimeout(() => (btn.textContent = 'Subscribe'), 2400);
    });
  });

  // Update year in footer
  document.querySelectorAll('[data-year]').forEach(el => {
    el.textContent = new Date().getFullYear();
  });

  // Animate numbers on scroll (counters)
  const counters = document.querySelectorAll('[data-count]');
  if ('IntersectionObserver' in window && counters.length) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const target = parseFloat(el.getAttribute('data-count'));
        const suffix = el.getAttribute('data-suffix') || '';
        const duration = 1400;
        const start = performance.now();
        const step = (now) => {
          const progress = Math.min((now - start) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          const value = target * eased;
          el.textContent = (target % 1 === 0 ? Math.round(value) : value.toFixed(1)) + suffix;
          if (progress < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        io.unobserve(el);
      });
    }, { threshold: 0.4 });
    counters.forEach(c => io.observe(c));
  }
});
