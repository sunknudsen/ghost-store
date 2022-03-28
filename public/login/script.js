const query = new Proxy(new URLSearchParams(window.location.search), {
  get: (searchParams, prop) => searchParams.get(prop),
})

const form = document.getElementById("form")
const button = document.getElementById("button")
const message = document.getElementById("message")

form.addEventListener("submit", async (event) => {
  event.preventDefault()
  button.setAttribute("aria-busy", true)
  const data = {
    email: form.email.value,
  }
  const redirect = query.redirect
  if (redirect) {
    data.redirect = `${redirect}${location.hash}`
  }
  const response = await fetch("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  })
  button.removeAttribute("aria-busy")
  const json = await response.json()
  if (response.status !== 200) {
    message.innerText = json.error
  } else {
    button.setAttribute("disabled", true)
    message.innerText = "Login successful, check your emails…"
  }
})

form.email.addEventListener("keyup", () => {
  button.removeAttribute("disabled")
})
