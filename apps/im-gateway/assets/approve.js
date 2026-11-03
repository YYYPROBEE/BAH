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

  var reloadOffered = false

  function disableAll() {
    if (approveEl) approveEl.disabled = true
    if (rejectEl) rejectEl.disabled = true
    if (verifyEl) verifyEl.disabled = true
  }

  /**
   * 失败态的人话 + 可点的「重新加载」。
   *
   * 审批链接没有登录态：401/403/404 都是"这条链接不能用了"，唯一自愈动作是重新打开；
   * 网络不通则需要用户恢复网络后重试。不能把 `TypeError: Failed to fetch` 甩到屏幕上。
   */
  function fail(message) {
    disableAll()
    say(message)
    if (reloadOffered || !statusEl) return
    reloadOffered = true
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'status-action'
    button.textContent = '重新加载'
    button.addEventListener('click', function () {
      window.location.reload()
    })
    statusEl.appendChild(button)
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
          var fallback =
            response.status === 410
              ? '审批链接已过期，请重新发起审批'
              : response.status === 401 || response.status === 403 || response.status === 404
                ? '审批链接已失效，请重新从 IM 消息打开'
                : '处理失败，请稍后重试'
          return {
            ok: false,
            code: error.code || '',
            reason: error.reason || fallback,
            status: response.status
          }
        })
    }).catch(function () {
      return {
        ok: false,
        code: 'network-error',
        reason: '网络不通，请检查信号后重试',
        status: 0
      }
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
        if (result.status === 401 || result.status === 403 || result.status === 404 || result.status === 410 || result.code === 'network-error') {
          fail(result.reason)
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
        if (result.ok) {
          say('已批准一次')
          return
        }
        fail(result.reason)
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
        if (result.ok) {
          say('已拒绝')
          return
        }
        fail(result.reason)
      })
    })
  }
})()
