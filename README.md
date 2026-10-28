# ABS Seva: Sammilani volunteer registration (Google Sheets version)

This is the volunteer registration site for the **112th Sarbabhouma Bhakta Sammilani, Kalyani, Balesore, Odisha** (Assam Bangiya Saraswat Math). It has no server to run:

- **The website** (`docs/`) is hosted free on GitHub Pages. It is a mobile-first app in Odia, Bengali, Assamese, Hindi and English, with voice input, a photo with the background removed, and offline saving.
- **The data** lives in a Google Sheet, with one tab per list: Volunteers, Ashrams, Lists, Groups, Remarks and Admins.
- **Photos** are saved in Google Drive, in a sub-folder of the main folder: **Volunteer photos**.
- **The connection** between them is a small Google Apps Script attached to the Sheet (`apps-script/Code.gs`).

**Volunteers can:**
- register in 5 short steps: about you, contact, Bibhagiya Ashram and Sangha, Seva, photo
- name a reference person, a Bibhagiya Sadasya and/or Zilla Sadasya (optional)
- later edit their details with their **registration number + mobile**, using "Edit my registration" or the WhatsApp link they saved

**Organisers** (`admin.html`) can:
- use filters, groups and team leaders, remarks, duplicate detection, lists, ID-card printing (8.56 × 5.4 cm) and CSV export
- log in with the username and password set for them in the **Admins** tab
- see only what their role and ashram allow:

| Role | Can |
|---|---|
| Super admin | everything: lists, ashrams, delete, merge |
| Coordinator | view, edit volunteers, groups, remarks, print cards |
| Card desk | view and print cards |
| Viewer | view only |

Put a Bibhagiya Ashram name in the **ashram** column to limit a login to that ashram. Leave it empty for all ashrams.

---

## One-time setup (about 20 minutes)

### 1. Put the code on GitHub
Push this repository to **github.com/namastevis/abs-seva**. Then go to repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 2. Create the Sheet
1. Open the Drive folder for this project. Choose **New → Google Sheets** and name the file **ABS Seva**.
2. In the Sheet, choose **Extensions → Apps Script**.
3. Delete the sample code, paste the whole of `apps-script/Code.gs`, and click **Save** (💾).
4. Choose **Project Settings** (⚙), tick **Show "appsscript.json" manifest file**, then go back to **Editor**. Open `appsscript.json`, replace its contents with `apps-script/appsscript.json`, and click **Save**.
5. At the top, choose the function **setup** and click **Run**. Google asks for permission. Choose your account, then **Advanced → Go to … (unsafe)**. That warning is normal for your own scripts. Then click **Allow**.

Setup does all of this:
- creates the tabs
- loads the 14 ashrams, the 24 Sevas (in 5 languages) and the 283 Bibhagiya/Zilla Sadasyas
- moves the Sheet into your Drive folder and creates the **Volunteer photos** and **Backups** sub-folders
- sets up a readable copy of the volunteer list (refreshed every 30 minutes) and a nightly backup of the whole Sheet (the last 21 are kept)

### 3. First admin password
In the **Admins** tab, type a password of 8 or more characters in the `password` cell of `superadmin`. Within a second it is replaced by a code (a salted hash), so nobody can read it back.

Your typed password stays in the Sheet's version history, so change it from the admin page after your first login, using the **Password** button.

Add a row for each organiser, with a username, a temporary password and a role. Leave the ashram column empty, or put one ashram's name. Ask each organiser to change their password after logging in.

### 4. Publish the script as a web app
1. In Apps Script, choose **Deploy → New deployment → ⚙ Select type → Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
3. Copy the **Web app URL**. It ends in `/exec`.

### 5. Connect the website
In `docs/config.js`, replace `https://script.google.com/macros/s/PASTE-YOUR-DEPLOYMENT-ID/exec` with your URL. Then commit and push.

GitHub Actions checks the code and publishes the site in about a minute:
- the form: **https://namastevis.github.io/abs-seva/**
- the admin page: **https://namastevis.github.io/abs-seva/admin.html**

### 6. Move the registrations over from the old site (VPS)
Do this right before you switch the link everyone uses.

1. In the Sheet, choose **Sammilani → Import from the old website**.
2. Enter `https://seva.namastevis.in` and the old admin username and password.

Every volunteer keeps their registration number. Photos and remarks are copied in the background, and it continues automatically every minute until all of them are done. Running the import again adds only registrations that are not in the Sheet yet. When it finishes, the old login details are deleted from the script.

**Order for the switch-over:**
1. Test the new site freely.
2. Run the import.
3. Point the link everyone uses at the new site straight away.
4. Run the import once more, to catch anyone who registered on the old site in the meantime.

The old site's numbers always win. If a registration made on the new site (for example a test entry) already uses a number the old site gave out, it gets the next free number and a remark saying so. You can delete test entries from the admin page.

### 7. Switch the address (optional)
To serve the site at `seva.namastevis.in`:
1. Add a `CNAME` file containing `seva.namastevis.in` in `docs/`.
2. In GitHub → Settings → Pages, set the custom domain.
3. Change the DNS record from the VPS IP to a `CNAME` pointing to `namastevis.github.io`.

---

## Keep it safe
- **Only you should be an Editor of the Sheet.** The script runs as you, with access to your Drive. Give organisers access through the admin page (Admins tab), not by sharing the Sheet. Ideally, use a Google account dedicated to this project.
- Don't share the Drive folder. Photos are viewable only by people who have each photo's exact link.
- See `SECURITY.md` for the security review and what was fixed.

## Changing things later
- **Lists:** Seva, Sangha, Sadasyas and ashrams can be changed in the admin page (Lists, Ashrams & Groups) or directly in the Sheet. The form shows changes within 2 minutes.
- **Website code** (`docs/`): commit and push. It goes live automatically, and phones pick up the new version.
- **Script code** (`apps-script/Code.gs`): paste the new version into Apps Script and save. Then choose **Deploy → Manage deployments → ✎ → Version: New version → Deploy**. The URL stays the same.

## Developing and testing without Google
`node tools/emulator.mjs` runs the real `Code.gs` against an in-memory copy of the Sheet:
- website: http://localhost:8787
- API: http://localhost:8788/exec

`ADMIN_PASS=…` sets the first admin password. GitHub Actions uses the same emulator for its smoke test.
