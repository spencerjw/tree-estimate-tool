/* ==========================================================================
   TreePro — AI Estimate Tool  |  app.js
   Handles: form validation, image preview/resize, API call, results render
   ========================================================================== */

// ---------------------------------------------------------------------------
// CONFIG — adjust these without touching anything else
// ---------------------------------------------------------------------------
const CONFIG = {
  // Max pixels on longest edge before we down-sample for upload
  MAX_IMAGE_PX: 1200,
  // JPEG quality after resize (0–1)
  IMAGE_QUALITY: 0.85,
  // Max number of photos
  MAX_PHOTOS: 3,
  // Endpoint — in production this hits /api/estimate (Vercel serverless)
  API_ENDPOINT: '/api/estimate',
  // Service labels for display
  SERVICE_LABELS: {
    removal:      'Tree Removal',
    trimming:     'Trimming / Pruning',
    storm_damage: 'Storm Damage Cleanup',
    emergency:    'Emergency Service',
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let selectedFiles = []; // Array of { file: File, dataUrl: string }

// ---------------------------------------------------------------------------
// DOM refs — grab once
// ---------------------------------------------------------------------------
const formSection    = document.getElementById('form-section');
const loadingSection = document.getElementById('loading-section');
const resultsSection = document.getElementById('results-section');
const apiError       = document.getElementById('api-error');
const form           = document.getElementById('estimate-form');
const uploadZone     = document.getElementById('upload-zone');
const photoInput     = document.getElementById('photo-input');
const photoPreviews  = document.getElementById('photo-previews');
const submitBtn      = document.getElementById('submit-btn');
const submitLabel    = document.getElementById('submit-label');
const loadingStep    = document.getElementById('loading-step');
const stepDots       = document.querySelectorAll('.step-dot');
const errorMsg       = document.getElementById('api-error-msg');
const footerYear     = document.getElementById('footer-year');

// Results refs
const resSpecies       = document.getElementById('res-species');
const resHeight        = document.getElementById('res-height');
const resDiameter      = document.getElementById('res-diameter');
const resCondition     = document.getElementById('res-condition');
const resComplexity    = document.getElementById('res-complexity');
const complexWrap      = document.getElementById('complexity-factors-wrap');
const complexList      = document.getElementById('complexity-factors');
const safetyWrap       = document.getElementById('safety-wrap');
const safetyList       = document.getElementById('safety-concerns');
const lineItemsBody    = document.getElementById('line-items-body');
const resServiceLabel  = document.getElementById('res-service-label');
const resTotal         = document.getElementById('res-total');
const resNotes         = document.getElementById('res-notes');

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
footerYear.textContent = new Date().getFullYear();

// ---------------------------------------------------------------------------
// Photo upload — drag/drop + click
// ---------------------------------------------------------------------------
uploadZone.addEventListener('click', () => photoInput.click());
photoInput.addEventListener('click', (e) => e.stopPropagation()); // prevent double-open on Windows
uploadZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); photoInput.click(); }
});

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  handleFiles(Array.from(e.dataTransfer.files));
});

photoInput.addEventListener('change', () => {
  handleFiles(Array.from(photoInput.files));
  photoInput.value = ''; // reset so same file can be re-selected if needed
});

function handleFiles(files) {
  const imageFiles = files.filter((f) => f.type.startsWith('image/'));
  const remaining  = CONFIG.MAX_PHOTOS - selectedFiles.length;

  if (remaining <= 0) {
    setPhotoError(`Maximum ${CONFIG.MAX_PHOTOS} photos allowed.`);
    return;
  }

  const toAdd = imageFiles.slice(0, remaining);
  if (imageFiles.length > remaining) {
    setPhotoError(`Only added ${remaining} photo(s) — max ${CONFIG.MAX_PHOTOS} total.`);
  } else {
    setPhotoError('');
  }

  toAdd.forEach((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      selectedFiles.push({ file, dataUrl: e.target.result });
      renderPreviews();
    };
    reader.readAsDataURL(file);
  });
}

function renderPreviews() {
  photoPreviews.innerHTML = '';
  selectedFiles.forEach((item, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview-item';

    const img = document.createElement('img');
    img.src = item.dataUrl;
    img.alt = `Tree photo ${idx + 1}`;

    const btn = document.createElement('button');
    btn.className = 'preview-remove';
    btn.type = 'button';
    btn.setAttribute('aria-label', `Remove photo ${idx + 1}`);
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      selectedFiles.splice(idx, 1);
      renderPreviews();
      setPhotoError('');
    });

    wrap.appendChild(img);
    wrap.appendChild(btn);
    photoPreviews.appendChild(wrap);
  });
}

function setPhotoError(msg) {
  document.getElementById('photo-error').textContent = msg;
}

// ---------------------------------------------------------------------------
// Client-side image resize — keeps payloads manageable
// ---------------------------------------------------------------------------
function resizeImage(dataUrl, mediaType) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const max  = CONFIG.MAX_IMAGE_PX;
      let { width, height } = img;

      if (width > max || height > max) {
        if (width > height) { height = Math.round((height * max) / width); width = max; }
        else                { width = Math.round((width * max) / height); height = max; }
      }

      const canvas    = document.createElement('canvas');
      canvas.width    = width;
      canvas.height   = height;
      const ctx       = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const outputType = mediaType === 'image/png' ? 'image/png' : 'image/jpeg';
      resolve({
        data:      canvas.toDataURL(outputType, CONFIG.IMAGE_QUALITY).split(',')[1],
        mediaType: outputType,
      });
    };
    img.src = dataUrl;
  });
}

// ---------------------------------------------------------------------------
// Form validation
// ---------------------------------------------------------------------------
function validateForm() {
  let valid = true;

  const fields = [
    { id: 'name',  label: 'Full name',    pattern: /\S{2,}/ },
    { id: 'email', label: 'Email address', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    { id: 'phone', label: 'Phone number',  pattern: /[\d\s\-()+]{7,}/ },
    { id: 'zip',   label: 'Zip code',      pattern: /^\d{5}(-\d{4})?$/ },
  ];

  fields.forEach(({ id, label, pattern }) => {
    const el        = document.getElementById(id);
    const errorEl   = el.parentElement.querySelector('.field-error');
    const val       = el.value.trim();

    if (!val) {
      errorEl.textContent = `${label} is required.`;
      el.classList.add('invalid');
      valid = false;
    } else if (!pattern.test(val)) {
      errorEl.textContent = `Please enter a valid ${label.toLowerCase()}.`;
      el.classList.add('invalid');
      valid = false;
    } else {
      errorEl.textContent = '';
      el.classList.remove('invalid');
    }
  });

  // Service type
  const serviceVal = form.querySelector('input[name="serviceType"]:checked')?.value;
  const serviceErr = document.getElementById('service-error');
  if (!serviceVal) {
    serviceErr.textContent = 'Please select a service type.';
    valid = false;
  } else {
    serviceErr.textContent = '';
  }

  // Photos
  if (selectedFiles.length === 0) {
    setPhotoError('Please upload at least one photo of the tree.');
    valid = false;
  }

  return valid;
}

// Clear field error on input
['name', 'email', 'phone', 'zip'].forEach((id) => {
  document.getElementById(id).addEventListener('input', function () {
    this.classList.remove('invalid');
    this.parentElement.querySelector('.field-error').textContent = '';
  });
});

// ---------------------------------------------------------------------------
// Loading animation
// ---------------------------------------------------------------------------
const LOADING_STEPS = [
  'Identifying species and size…',
  'Assessing condition and complexity…',
  'Calculating Central Texas market rates…',
  'Finalizing your estimate…',
];

let loadingInterval = null;

function startLoading() {
  let step = 0;
  loadingStep.textContent = LOADING_STEPS[0];
  stepDots.forEach((d, i) => d.classList.toggle('active', i === 0));

  loadingInterval = setInterval(() => {
    step = (step + 1) % LOADING_STEPS.length;
    loadingStep.style.opacity = '0';
    setTimeout(() => {
      loadingStep.textContent = LOADING_STEPS[step];
      loadingStep.style.opacity = '1';
      stepDots.forEach((d, i) => d.classList.toggle('active', i === step));
    }, 200);
  }, 2200);
}

function stopLoading() {
  clearInterval(loadingInterval);
}

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------
function formatMoney(n) {
  return '$' + Number(n).toLocaleString('en-US');
}

function conditionClass(c) {
  const map = { Healthy: 'healthy', Fair: 'fair', Poor: 'poor', Hazardous: 'hazardous' };
  return 'condition-' + (map[c] ?? 'fair');
}

function complexityClass(c) {
  const map = {
    'Low':       'low',
    'Medium':    'medium',
    'High':      'high',
    'Very High': 'very-high',
  };
  return 'complexity-' + (map[c] ?? 'medium');
}

function renderResults(estimate, serviceType) {
  // Assessment card
  resSpecies.textContent  = estimate.species            || '—';
  resHeight.textContent   = estimate.estimated_height   || '—';
  resDiameter.textContent = estimate.trunk_diameter     || '—';

  resCondition.textContent  = estimate.condition  || '—';
  resCondition.className    = conditionClass(estimate.condition);

  resComplexity.textContent = estimate.complexity || '—';
  resComplexity.className   = complexityClass(estimate.complexity);

  // Complexity factors
  if (estimate.complexity_factors?.length) {
    complexList.innerHTML = estimate.complexity_factors
      .map((f) => `<li>${escapeHtml(f)}</li>`).join('');
    complexWrap.classList.remove('hidden');
  } else {
    complexWrap.classList.add('hidden');
  }

  // Safety concerns
  if (estimate.safety_concerns?.length) {
    safetyList.innerHTML = estimate.safety_concerns
      .map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    safetyWrap.classList.remove('hidden');
  } else {
    safetyWrap.classList.add('hidden');
  }

  // Estimate table
  resServiceLabel.textContent = CONFIG.SERVICE_LABELS[serviceType] || serviceType;
  lineItemsBody.innerHTML     = (estimate.line_items || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.description)}</td>
      <td class="col-price">${formatMoney(item.price_low)} – ${formatMoney(item.price_high)}</td>
    </tr>
  `).join('');

  resTotal.textContent = `${formatMoney(estimate.total_low)} – ${formatMoney(estimate.total_high)}`;

  resNotes.textContent = estimate.notes || '';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Section visibility helpers
// ---------------------------------------------------------------------------
function showSection(section) {
  [formSection, loadingSection, resultsSection, apiError].forEach((el) => {
    el.classList.toggle('hidden', el !== section);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Form submission
// ---------------------------------------------------------------------------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validateForm()) return;

  const name        = document.getElementById('name').value.trim();
  const email       = document.getElementById('email').value.trim();
  const phone       = document.getElementById('phone').value.trim();
  const zip         = document.getElementById('zip').value.trim();
  const serviceType = form.querySelector('input[name="serviceType"]:checked').value;

  // Disable submit to prevent double-submit
  submitBtn.disabled = true;
  submitLabel.textContent = 'Analyzing…';

  showSection(loadingSection);
  startLoading();

  try {
    // Resize & encode all images
    const images = await Promise.all(
      selectedFiles.map((item) => {
        const mediaType = item.file.type || 'image/jpeg';
        return resizeImage(item.dataUrl, mediaType);
      })
    );

    const response = await fetch(CONFIG.API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone, zip, serviceType, images }),
    });

    const json = await response.json();

    if (!response.ok) {
      // Photo validation failure — send user back to upload step with a clear message
      if (response.status === 422 && json.validation_failed) {
        stopLoading();
        setPhotoError(json.error || 'We could not identify tree-related content in your photos. Please upload clear photos of the tree or damage you need assessed.');
        // Clear uploaded photos so they have to re-upload
        selectedFiles = [];
        photoPreviews.innerHTML = '';
        // Show form section again
        showSection(formSection);
        submitBtn.disabled = false;
        submitLabel.textContent = 'Get My Free Estimate';
        return;
      }
      throw new Error(json.error || 'Unknown server error.');
    }

    stopLoading();
    renderResults(json.estimate, serviceType);
    showSection(resultsSection);

  } catch (err) {
    stopLoading();
    errorMsg.textContent = err.message || 'Please try again.';
    showSection(null); // show error only
    apiError.classList.remove('hidden');
    formSection.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitLabel.textContent = 'Get My Free Estimate';
  }
});

// ---------------------------------------------------------------------------
// "Try again" and "Submit another" buttons
// ---------------------------------------------------------------------------
document.getElementById('error-retry-btn').addEventListener('click', () => {
  apiError.classList.add('hidden');
});

document.getElementById('cta-restart-btn').addEventListener('click', () => {
  // Reset form state
  form.reset();
  selectedFiles = [];
  photoPreviews.innerHTML = '';
  setPhotoError('');
  document.querySelectorAll('.field-error').forEach((el) => el.textContent = '');
  document.querySelectorAll('input.invalid').forEach((el) => el.classList.remove('invalid'));

  showSection(formSection);
});

// ---------------------------------------------------------------------------
// Branding — fetch customer config and update header/CTA with business name
// ---------------------------------------------------------------------------
(async function applyBranding() {
  try {
    const resp = await fetch('/api/config');
    if (!resp.ok) return;
    const { businessName, phone, theme, status } = await resp.json();

    if (status === 'paused' || status === 'canceled') {
      document.body.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0d0f;font-family:sans-serif;padding:24px;">
          <div style="max-width:480px;width:100%;background:#14191e;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:48px 40px;text-align:center;color:#e8edf2;">
            <div style="font-size:48px;margin-bottom:20px;">🌳</div>
            <h1 style="font-size:22px;font-weight:700;margin-bottom:12px;">Service Unavailable</h1>
            <p style="color:#b6bfc8;font-size:15px;line-height:1.6;">This estimate tool is temporarily unavailable. Please contact the business directly for a quote.</p>
          </div>
        </div>`;
      return;
    }

    if (theme && theme !== 'forest-green') {
      const THEMES = {
        'deep-navy':      { main: '#3b82f6', hover: '#1d4ed8', soft: 'rgba(59,130,246,0.12)',  glow: 'rgba(59,130,246,0.25)'  },
        'slate-gray':     { main: '#64748b', hover: '#475569', soft: 'rgba(100,116,139,0.12)', glow: 'rgba(100,116,139,0.25)' },
        'burnt-orange':   { main: '#f97316', hover: '#ea580c', soft: 'rgba(249,115,22,0.12)',  glow: 'rgba(249,115,22,0.25)'  },
        'burgundy-red':   { main: '#e11d48', hover: '#9f1239', soft: 'rgba(225,29,72,0.12)',   glow: 'rgba(225,29,72,0.25)'   },
        'charcoal-black': { main: '#6b7280', hover: '#4b5563', soft: 'rgba(107,114,128,0.12)', glow: 'rgba(107,114,128,0.25)' },
      };
      const t = THEMES[theme];
      if (t) {
        const root = document.documentElement;
        root.style.setProperty('--green',       t.main);
        root.style.setProperty('--green-hover',  t.hover);
        root.style.setProperty('--green-soft',   t.soft);
        root.style.setProperty('--green-glow',   t.glow);
      }
    }

    if (businessName) {
      const logoName = document.querySelector('.logo-name');
      if (logoName) logoName.textContent = businessName;
      const footerCompany = document.getElementById('footer-company');
      if (footerCompany) footerCompany.textContent = businessName;
      document.title = `Free Tree Estimate — ${businessName}`;
    }

    if (phone) {
      const ctaBtn = document.getElementById('cta-call-btn');
      if (ctaBtn) {
        ctaBtn.href        = `tel:${phone}`;
        ctaBtn.textContent = `📞 Call ${phone} — Book Your Free On-Site Visit`;
      }
    }
  } catch {
    // Silently fail — page works fine with default static content
  }
})();
