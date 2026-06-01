---
name: clean-code
description: Skill de nettoyage de code, incluant la suppression de code fallback inutile, l'allègement des vérifications redondantes et la simplification des fonctions à usage unique.
---

# Skill de nettoyage de code

C'est un travail long et important, à réaliser progressivement. Formule d'abord une liste des points à améliorer en suivant la liste des tâches. Il faut pouvoir réaliser un nettoyage de manière approfondie et efficace petit à petit sur chaque cas, en se concentrant bien sur les points suivants :

- Retire le code fallback inutile et legacy inutile.
- Allège la redondance des checks/guards dont on connait déjà les types et valeurs : String(), Number(), `${...}`, typeof, instanceof, Array.isArray, etc.
- Utilise String() ou .toString() pour faire du string casting, et privilégie les template literals pour faire du string interpolation.
- Conserve les guards de sécurité nécessaires.
- Supprime les fonctions à usage unique qui ne font qu'appeler une autre fonction. Raccorde directement à la fonction appelée.
- Privilégie les flows implicites quand il s'agit de l'usage d'utilitaires ou de fonctions d'instance connues, au lieu de faire régulièrement des checks explicites et redondants.
- Retire les early returns silencieux et redondants. Nous préférons que le code plante en montrant une erreur claire plutôt que de camoufler une erreur potentielle derrière un return silencieux.
