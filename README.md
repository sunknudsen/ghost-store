# ghost-store

## Sell downloads and masterclasses on Ghost.

[Ghost](https://ghost.org/) is an amazing open source publication platform used by content creators to monetize their content.

Selling downloads and masterclasses is not currently possible on Ghost so I created ghost-store to scratch my own itch.

Implementing ghost-store it not straightforward… this repo was made public so other technologists don’t have to go down the rabbit hole like I did.

**Want to experience ghost-store?** [Join](https://sunknudsen.com/join/) and check out [https://sunknudsen.com/qr-bridge/](https://sunknudsen.com/qr-bridge/).

## Implementation overview

### Step 1: create and configure [Stripe](https://stripe.com/) account

Go to [https://dashboard.stripe.com/settings/user](https://dashboard.stripe.com/settings/user) and configure user.

Go to [https://dashboard.stripe.com/settings/emails](https://dashboard.stripe.com/settings/emails) and configure emails.

Go to [https://dashboard.stripe.com/settings/branding](https://dashboard.stripe.com/settings/branding) and configure branding.

### Step 2: create restricted Stripe API key

Go to [https://dashboard.stripe.com/developers](https://dashboard.stripe.com/developers) and create restricted API key with following permissions.

Customers 👉 Read

Checkout Sessions 👉 Read

### Step 3: create Stripe webhook

Go to [https://dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks) and create webhook with following events that points to ghost-store service.

Events to send 👉 `checkout.session.completed`

### Step 4: add Stripe products and create payment links

Go to [https://dashboard.stripe.com/products](https://dashboard.stripe.com/products), add products and create payment links

### Step 5: setup [Mailgun](https://www.mailgun.com/) account

### Step 6: create database, user and grant privileges using `mysql --user root --password`

> Heads-up: replace `ghost_store_prod`, `ghost-store-123` and `d4q6g3w2kulttgtvsw43u5z8f69k` to match environment variables in `.env`.

```
CREATE DATABASE ghost_store_prod;
CREATE USER 'ghost-store-123'@'localhost' IDENTIFIED BY 'd4q6g3w2kulttgtvsw43u5z8f69k';
GRANT ALL PRIVILEGES ON ghost_store_prod.* TO 'ghost-store-123'@'localhost';
FLUSH PRIVILEGES;
```

### Step 7: add ghost-store custom integration on `/ghost/#/settings/integrations`

### Step 8: append following code after `{{ghost_head}}` in `default.hbs` (see [example](https://github.com/sunknudsen/custom-ghost-edition-theme/blob/a4e1f033b013d7c0e04e14e8c873f38a2390b41e/default.hbs#L12-L15))

```handlebars
{{#if @member}}

  <script>var member_email="{{@member.email}}";</script>
{{/if}}
```

### Step 9: create confirmation page (configured using `GHOST_CONFIRMATION_PAGE` environment variable, see [example](https://sunknudsen.com/almost-there/))

### Step 10: configure and run ghost-store

Clone [ghost-store](https://github.com/sunknudsen/ghost-store), create `.env`, `store.json` and `template.hbs`, run `node index.js` and point subdomain to service (complexity of step has been abstracted).

## Usage overview

### Implement member-only product

#### Step 1: add link to ghost-store product on page or post leaving email blank

> Heads-up: replace `http://localhost:8443` to match environment variable in `.env`.

http://localhost:8443/store?path=qr-bridge&email=

#### Step 2: add following code to page or post footer using code injection

> Heads-up: replace `http://localhost:8443` to match environment variable in `.env`.

```html
<script>
  if (member_email) {
    const ghostStoreAnchors = document.querySelectorAll(
      "a[href*='http://localhost:8443']"
    )
    ghostStoreAnchors.forEach(function (ghostStoreAnchor) {
      ghostStoreAnchor.setAttribute(
        "href",
        ghostStoreAnchor.href.replace("email=", `email=${member_email}`)
      )
    })
  }
</script>
```

### Send complimentary product (membership not required)

#### Step 1: install [HTTPie](https://httpie.io/)

#### Step 2: send `POST` request to `/admin`

> Heads-up: replace `http://localhost:8443` and `b1vtyyzkhrcqosg0iioi4b6w7zo0` to match environment variables in `.env`.

```
http POST http://localhost:8443/admin \
"Authorization: Bearer b1vtyyzkhrcqosg0iioi4b6w7zo0" \
name="John Doe" \
email="john@privacyconscio.us" \
path="qr-bridge"
```
