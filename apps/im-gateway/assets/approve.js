/* H5 审批页交互（03 单）。零框架、零远程请求、不写 cookie / localStorage。 */
(function () {
  'use strict'

  var statusEl = document.getElementById('status')
  var approveEl = document.getElementById('approve')
  var rejectEl = document.getElementById('reject')
  var verifyEl = document.getElementById('verify')
  var reasonEl = document.getElementById('reason')
  var body = document.body
  var path = window.location.pathname

  function say(text) {
    if (statusEl) statusEl.textContent = text
  }

  function disableAll() {
    if (approveEl) approveEl.disabled = true
    if (rejectEl) rejectEl.disabled = true
    if (verifyEl) verifyEl.disabled = true
  }

  function call(suffix, payload) {
    return fetch(path + suffix, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(payload || {})
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {}
        })
        .then(function (data) {
          if (response.ok && data && data.ok) return { ok: true }
          var error = (data && data.error) || {}
          return {
            ok: false,
            code: error.code || '',
            reason: error.reason || '处理失败，请稍后重试'
          }
        })
    })
  }

  var expiresAt = Number(body.getAttribute('data-expires-at') || '0')
  if (expiresAt > 0) {
    var tick = function () {
      var left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      var countdown = document.getElementById('countdown')
      if (countdown) countdown.textContent = left > 0 ? left + ' 秒' : '已过期'
      if (left === 0) {
        disableAll()
        say('票据已过期')
      }
    }
    tick()
    window.setInterval(tick, 1000)
  }

  if (verifyEl) {
    verifyEl.addEventListener('click', function () {
      disableAll()
      say('正在验证…')
      call('/verify', {}).then(function (result) {
        if (result.ok) {
          if (approveEl) approveEl.disabled = false
          if (rejectEl) rejectEl.disabled = false
          say('验证通过，可以批准一次')
          return
        }
        if (verifyEl) verifyEl.disabled = false
        if (rejectEl) rejectEl.disabled = false
        say(result.reason)
      })
    })
  }

  if (approveEl) {
    approveEl.addEventListener('click', function () {
      disableAll()
      say('正在提交…')
      call('', { decision: 'allowed-once' }).then(function (result) {
        say(result.ok ? '已批准一次' : result.reason)
      })
    })
  }

  if (rejectEl) {
    rejectEl.addEventListener('click', function () {
      var reason = reasonEl ? reasonEl.value.trim() : ''
      if (reason.length === 0) {
        say('请填写拒绝理由')
        return
      }
      disableAll()
      say('正在提交…')
      call('', { decision: 'rejected', reason: reason }).then(function (result) {
        say(result.ok ? '已拒绝' : result.reason)
      })
    })
  }
})()
