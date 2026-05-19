# ZuperPatch!

ZuperPatch! est un outil de planification de câblage sur plan.

Il aide à préparer une installation avant d’arriver sur site: importer un plan, définir une échelle fiable, tracer les câbles, positionner les équipements, vérifier les distances, repérer les charges et produire une liste de matériel exploitable.

L’objectif est simple: transformer un plan de salle en estimation claire, vérifiable et partageable.

## Ce que ZuperPatch! permet de faire

### Travailler directement sur un plan PDF

Importez un plan de sol au format PDF et utilisez-le comme base de travail. Le plan reste visible sous les éléments de câblage, avec un contrôle d’opacité pour l’adapter à la lisibilité du moment.

En mode sombre, le plan est inversé pour garder un bon contraste sans perdre le confort visuel.

### Définir une échelle réelle

Tracez une distance connue sur le plan, indiquez sa longueur réelle, et ZuperPatch! convertit ensuite les tracés en mètres.

C’est la base de tout le reste: les distances de câbles, les alertes de longueur et la liste de matériel s’appuient sur cette calibration.

### Tracer plusieurs types de câbles

ZuperPatch! prend en charge les familles de câbles utiles au pré-câblage événementiel et technique:

- Ethernet
- Électrique
- XLR

Chaque câble connaît sa longueur maximale recommandée. Les tracés utilisent un rendu progressif pour rendre les longues distances plus faciles à lire pendant la conception.

### Gérer les équipements du plan

Ajoutez les équipements directement sur le plan:

- Sources électriques
- Multiprises
- Switches Ethernet
- Clients Ethernet
- Consommateurs électriques

Chaque équipement porte ses informations métier: nom, puissance disponible, puissance consommée, nombre de prises ou ports, besoin PoE, position de libellé, et connexions associées.

### Vérifier les capacités et les raccordements

ZuperPatch! ne se contente pas de dessiner des lignes.

L’outil suit les relations entre câbles et équipements pour éviter les incohérences évidentes:

- Un consommateur électrique ne peut être alimenté qu’une seule fois.
- Un client Ethernet se raccorde à un switch, pas à un autre client.
- Les sources électriques et switches peuvent avoir une capacité configurée.
- Les multiprises suivent les prises occupées, les prises libres souhaitées et leurs alimentations.
- Les besoins PoE des clients remontent vers le switch concerné.

Les équipements non raccordés peuvent être animés pour attirer l’attention sur ce qui reste à traiter.

### Aider au placement et au dessin

L’interface est pensée pour dessiner vite, corriger vite, et rester lisible:

- Accrochage des câbles à 45 degrés avec `Shift`
- Ajout, déplacement et suppression de points intermédiaires
- Détachement des extrémités de câble depuis leurs poignées
- Déplacement d’un équipement avec ses câbles attachés
- Pan temporaire avec la barre d’espace, comme dans les outils de dessin
- Zoom jusqu’à 500 %
- Restauration automatique du zoom, de la position et du projet

### Visualiser les flux

Lorsqu’un équipement est sélectionné, ZuperPatch! peut montrer le chemin emprunté par l’énergie ou la donnée.

Les flux sont dessinés à l’intérieur des traits existants pour garder le plan propre: ils servent à comprendre rapidement d’où vient l’alimentation, où passe le réseau, et quels liens sont impliqués.

### Suivre les statistiques en direct

La barre latérale résume les distances par type de câble et signale les informations importantes:

- Longueur totale par famille
- Nombre de câbles tracés
- Longueur maximale recommandée
- Souscriptions électriques
- Charges PoE
- Capacités de prises et de ports

Ces chiffres évoluent pendant que le plan est modifié.

### Produire une liste de matériel

ZuperPatch! génère un Bill of Materials téléchargeable en PDF.

La liste détaille les équipements nécessaires et chaque câble individuel avec sa longueur requise. Les familles de câbles sont regroupées clairement avec les mêmes couleurs que dans l’interface, pour rendre le document lisible même hors de l’application.

### Sauvegarder et reprendre le travail

Le projet est sauvegardé automatiquement dans le navigateur.

Il est aussi possible de télécharger et recharger un fichier projet pour archiver une version, transférer le travail ou reprendre une préparation plus tard.

## Pour qui

ZuperPatch! s’adresse aux équipes qui préparent des installations techniques avant intervention:

- événementiel
- audiovisuel
- réseau temporaire
- salles de réunion
- plateaux
- espaces techniques
- déploiements ponctuels

Il ne remplace pas une validation électrique réglementaire, mais il donne une base claire pour préparer le matériel, discuter le plan et réduire les oublis.

## Philosophie

ZuperPatch! vise un usage très concret: préparer le chantier, vérifier les longueurs, comprendre les dépendances et sortir une liste exploitable.

Pas de dessin décoratif inutile. Pas de tableur bricolé à côté. Le plan, les câbles, les équipements, les capacités et le matériel restent dans le même outil.

## Développement

```bash
npm install
npm run dev
```

Vérification de production:

```bash
npm run lint
npm run build
```
