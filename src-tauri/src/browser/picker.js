(function () {
  if (window.__trPickerTeardown) {
    try {
      window.__trPickerTeardown();
    } catch (e) {
    }
  }

  var TOKEN = "__TR_PICKER_TOKEN__";
  var hovered = null;
  var selected = null;

  var stringify = JSON.stringify;
  var handler = window.webkit && window.webkit.messageHandlers
    ? window.webkit.messageHandlers.trPicker
    : null;
  var post = handler ? handler.postMessage.bind(handler) : null;

  var MAX_OUTER_HTML_CHARS = 20000;

  function send(payload) {
    if (!post) return;
    payload.token = TOKEN;
    try {
      post(stringify(payload));
    } catch (e) {
    }
  }

  function componentNameOf(el) {
    return (
      el.getAttribute('data-component') ||
      el.getAttribute('data-testid') ||
      el.tagName.toLowerCase()
    );
  }

  function outline(el, on) {
    if (!el) return;
    el.style.outline = on ? '2px solid #4c8bf5' : '';
    el.style.outlineOffset = on ? '-2px' : '';
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom };
  }

  function onMouseOver(e) {
    if (hovered === e.target) return;
    outline(hovered, false);
    hovered = e.target;
    outline(hovered, true);
  }

  function onMouseOut(e) {
    if (hovered === e.target) {
      outline(hovered, false);
      hovered = null;
    }
  }

  function payloadFor(el) {
    return {
      componentName: componentNameOf(el),
      tagName: el.tagName,
      className: el.className || '',
      elementId: el.id || '',
      outerHTML: String(el.outerHTML).slice(0, MAX_OUTER_HTML_CHARS),
      rect: rectOf(el),
      selectionCount: 1
    };
  }

  // The page must not also act on this click: a picker click selects, it never
  // navigates, submits or opens whatever the page attached to the same element.
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    outline(hovered, false);
    hovered = null;
    selected = el;
    var payload = payloadFor(el);
    payload.type = 'element-selected';
    send(payload);
  }

  function clearSelection() {
    outline(hovered, false);
    outline(selected, false);
    hovered = null;
    selected = null;
    send({ type: 'element-deselected' });
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      clearSelection();
    }
  }

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  // The selections come from this script's own `selected`, never from the host's
  // arguments: letting the host hand back page-authored text would make the payload
  // forgeable. The host supplies only what the user typed, and who to send it to.
  window.__trPickerSubmit = function (userPrompt, agentId) {
    if (!selected) return false;
    var payload = payloadFor(selected);
    send({
      type: 'prompt-submitted',
      userPrompt: String(userPrompt == null ? '' : userPrompt),
      agentId: String(agentId == null ? '' : agentId),
      selections: [payload]
    });
    return true;
  };
  window.__trPickerClear = clearSelection;
  window.__trPickerTeardown = function () {
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    outline(hovered, false);
    outline(selected, false);
    delete window.__trPickerClear;
    delete window.__trPickerSubmit;
    delete window.__trPickerTeardown;
  };
})();
