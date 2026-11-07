// A tiny element builder. h('a', { href }, 'text') -> <a href>text</a>
//
// Security: children are added as text nodes (or existing elements), never as
// HTML strings. Model outputs and user input are untrusted, so the UI never
// uses innerHTML. A prompt output containing <script> is just shown as text.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value' || key === 'checked') el[key] = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    // Styles go through the CSSOM. A style="" attribute would be blocked by the
    // Content-Security-Policy (style-src 'self'), but el.style is allowed.
    else if (key === 'style') Object.assign(el.style, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
  return parent;
}

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

// Reads a <form> into a plain object (strings), with checkboxes as booleans.
export function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return values;
}
