# Ligne R · départs de Paris Gare de Lyon

Petite appli web (installable sur le téléphone) qui affiche les prochains départs de la ligne R depuis Paris Gare de Lyon en **croisant deux sources temps réel** :

| Source | Ce qu'elle apporte |
|---|---|
| Île-de-France Mobilités (API PRIM, « Prochains passages ») | heure estimée, **voie**, code mission (ZOVA, GAMO…), statut supprimé. C'est la même source que les applis RATP / Bonjour RATP et IDFM. |
| Île-de-France Mobilités (API PRIM, « Messages info trafic ») | perturbations et travaux de la ligne R |
| SNCF (api.sncf.com) | heure estimée côté SNCF, suppressions et messages par train |

Pour chaque train, l'appli affiche l'heure la plus prudente (la plus tardive des deux estimations) et signale :
- **Sources d'accord** : moins de 2 min d'écart ;
- **Écart de X min entre sources** ;
- **Absent côté SNCF / IDFM** : le train n'apparaît que dans une source ;
- **Supprimé** (ou « supprimé selon une seule source »).

Le tableau Gares & Connexions, Transilien et Bonjour RATP n'ont pas d'API publique : ils sont accessibles en liens en bas de page.

## 1. Obtenir les deux clés (gratuites)

1. **PRIM** : créer un compte sur <https://prim.iledefrance-mobilites.fr>, puis *Mon compte → Mon jeton d'API → Générer*.
2. **SNCF** : remplir le formulaire sur <https://numerique.sncf.com/startup/api/> ; la clé arrive par e-mail.

## 2. Adresse

Publiée avec GitHub Pages : `https://vb023.github.io/Ligne-R/`

(Activation : *Settings → Pages* → *Deploy from a branch*, branche `main`, dossier `/ (root)`.)

## 3. L'installer sur le téléphone

- **iPhone (Safari)** : ouvrir l'adresse → bouton Partager → *Sur l'écran d'accueil*.
- **Android (Chrome)** : menu ⋮ → *Installer l'application*.

Au premier lancement, ouvrir les réglages (roue dentée), coller les deux clés, enregistrer. Les clés restent dans le stockage local du téléphone ; elles ne sont **jamais** dans le dépôt. Le mode démo permet de voir l'affichage sans clé.

## 4. Si une source est en rouge « bloqué par le navigateur »

Certains serveurs d'API refusent les appels venant directement d'une page web (règle CORS). Dans ce cas, on passe par un petit relais gratuit :

1. Créer un compte sur <https://dash.cloudflare.com> → *Workers & Pages → Create → Worker*.
2. Remplacer le code par le contenu de `relais/worker.js` → *Deploy*.
3. *Settings → Variables and Secrets* : ajouter les secrets `PRIM_KEY` et `SNCF_KEY`, et la variable `ORIGINE` = `https://vb023.github.io`.
4. Dans les réglages de l'appli, coller l'adresse du Worker (`https://….workers.dev`) dans « Adresse du relais ». Les champs de clés peuvent alors rester vides.

Le relais n'accepte que les trois types de requêtes utilisés par l'appli.

## Identifiants utilisés

- Ligne R, référentiel IDFM : `C01731` (modifiable dans *Réglages → Identifiants avancés*).
- Gare de Lyon côté IDFM : zone de correspondance détectée automatiquement au premier lancement.
- Gare de Lyon côté SNCF : `stop_area:SNCF:87686006`.

Si la ligne n'affiche rien alors que les sources sont vertes, vérifier le code ligne dans le jeu de données « Référentiel des lignes » sur PRIM.

## Quotas

Actualisation toutes les 60 s, uniquement quand l'appli est ouverte à l'écran. L'API SNCF gratuite autorise plusieurs milliers de requêtes par jour : largement suffisant pour un usage personnel.
