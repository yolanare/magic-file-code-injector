---
name: comment-code
description: Guidelines for self-explanatory code and meaningful documentation. Activate when working with comments, docstrings, documentation, code clarity, API documentation, JSDoc, or discussing code commenting strategies. Guides on why over what, anti-patterns, decision frameworks, and language-specific examples.
---

# Guide de commentaire de code

C'est un travail important. Il faut pouvoir réaliser les commentaires de manière approfondie et efficace petit à petit sur chaque cas, en se concentrant sur les points suivants :
- Écrire du code qui se suffit à lui-même. Commenter uniquement lorsque c'est nécessaire pour expliquer le POURQUOI, pas le QUOI.
- Détaille systématiquement au dessus des méthodes et fonctions publiques, les paramètres, les valeurs de retour, les exceptions, et les exemples d'utilisation sous forme de JSDoc ou docstrings.
- Éviter les commentaires évidents, redondants, obsolètes, ou bruyants qui n'ajoutent pas de valeur à la compréhension du code.
- Utiliser les commentaires pour expliquer également à l'intérieur des méthodes la logique métier, les algorithmes complexes, les compromis de conception, les contournements de bugs, les contrats d'API, les motifs regex, les considérations de performance, et les comportements surprenants.
- Pas besoin de commenter les callbacks d'utilitaires connus, laisser le fonctionnement implicitement compris.
- Refactoriser le code pour qu'il soit plus clair plutôt que de commenter du code confus. Un bon nom de variable ou une fonction extraite peut éliminer le besoin de commentaires.

## Priority order

1. **Clear code**: Self-explanatory through naming and structure
2. **Good comments**: Explain WHY when necessary
3. **Documentation**: API docs, docstrings for public interfaces
4. **Maintain accuracy**: Update comments when code changes, or remove them if they become misleading
