# Patch

## Fichier modifie

- `js/SuperCSSInject.js`

## Changement

Le content script a ete modifie pour corriger deux points:

- refresh live reload sans assignation no-op
- normalisation des URLs injectees pour eviter les doublons

Principes appliques:

```js
// 1) Base URL stable (sans supercssinject_reload)
const baseHref = normalizeHref(link.href)
link.setAttribute("data-supercssinject-base-href", baseHref)

// 2) Refresh en remplaçant le <link> avec la meme URL
const next = link.cloneNode(false)
next.href = baseHref
next.setAttribute("data-supercssinject-base-href", baseHref)
link.replaceWith(next)

// 3) Comparaison des styles injectes sur URL normalisee
//    (sinon chaque refresh cree des liens en double)
```

## Pourquoi ce patch

- `e.href = e.href` reutilise la meme URL, donc le navigateur peut garder la feuille CSS en cache sans vrai refetch.
- En live reload, le message WS est bien recu, mais `e.href = e.href` ne force pas un rechargement fiable.
- Remplacer le noeud `<link>` force le navigateur a re-evaluer/recharger la feuille.
- Sans normalisation, les URLs avec timestamp ne matchent plus la liste de base et des liens CSS s'accumulent.
- L'accumulation cree des logs Vite de plus en plus longs et peut ralentir le refresh.
