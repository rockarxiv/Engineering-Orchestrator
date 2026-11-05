import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "./query/client";
import { RefetchOnReconnect } from "./query/RefetchOnReconnect";
import { FirstRunGate } from "./chat/firstRun/FirstRunGate";
import { KeepOrMoveSheet } from "./chat/firstRun/KeepOrMoveSheet";
import { InvitationGate } from "./chat/invitations/AcceptInvitation";
import { ServedSignInGate } from "./chat/admin/ServedSignIn";
import { AdminAuthorityProvider } from "./shared/admin/authority";
import { ItemReferenceProvider } from "./chat/conversation/ItemReferenceProvider";
import { ViewPublisher } from "./shared/view/ViewPublisher";
import { ChatWindow } from "./chat/ChatFrame";
import { DebugHotkey } from "./debug/DebugHotkey";
import { DebugWindow } from "./debug/DebugWindow";
import { isDebugWindow } from "./debug/debugMode";

// HashRouter, not BrowserRouter: the production build is loaded via
// loadFile() (a file:// URL), which has no server to resolve real paths.
export function App() {
  // Owned by the component rather than the module: a module-level client
  // outlives every App instance, so its cache leaks between them — which
  // in tests means one case serving another's stale data.
  const [queryClient] = useState(createQueryClient);

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* Under the provider and above every screen (EO-321): a
            reconnection is about the whole cache, not about whatever
            happens to be mounted. Renders nothing. */}
        <RefetchOnReconnect />
        {/* F12, while debug mode is on (EO-392). Above everything that
            can be on screen, so the key works from the first-run flow
            to Settings; it renders nothing and, with debug mode off,
            listens for nothing. */}
        <DebugHotkey />
        {/* The debug window is this same bundle loaded with
            `?window=debug`, and it is that window and nothing else: no
            router, so none of what hangs off an address — the first-run
            gate, the chat frame, the view publisher — is in it to need
            telling that it should stay out. */}
        {isDebugWindow() ? <DebugWindow /> : (
        <>
        {/* Somebody who is not yet anybody, holding a one-time link
            (EO-323). Above the router because the link is a *path* and
            this is a `HashRouter` — see `InvitationGate`, which is where
            that whole argument lives. Above `FirstRunGate` too: a
            colleague accepting an invitation on a server has no first run
            of their own to be shown. */}
        <InvitationGate>
        {/* A browser with no credential is shown the front door
            (EO-326, ARCHITECTURE.md, "The server"). Below the invitation gate, because somebody
            following a one-time link is precisely the person who has no
            credential yet and must not be asked for one; above
            everything else, because a tab that is nobody can draw no
            screen — every record channel answers it a sentence about a
            missing token. Renders its children unchanged on a desktop
            and in any tab that already holds a key. */}
        <ServedSignInGate>
        {/* Read-only by default, for an admin looking into projects that
            are not theirs (ARCHITECTURE.md, "Identity"). Above the router so that pressing "Act
            as admin" on the item page is still pressed when the same
            card is dragged on the board — one decision, not two. */}
        <AdminAuthorityProvider>
        <HashRouter>
          {/* Inside the router and around everything (EO-192): it reads
              the location, and every screen that has a filter or a
              selection contributes it from underneath. What it sends is
              identifiers and view parameters only — see ViewPublisher,
              where the reason that line is drawn where it is belongs. */}
          <ViewPublisher>
            <ItemReferenceProvider>
              {/* First run, before any of it (EO-317, ARCHITECTURE.md, "What a person sees first"). A
                  fresh installation is shown the flow rather than an
                  empty board: mode, gallery, Preview, blanks, needs
                  check, first item. Inside the router because the flow
                  navigates at the end of itself, and around the window
                  rather than inside a view because it is not a place —
                  it is the state the whole window is in until somebody
                  has something of their own, the conversation included,
                  since an assistant over the welcome screen would be
                  offering an agent nobody has configured yet. */}
              <FirstRunGate>
                {/* The window (`chat/ChatFrame.tsx`): the conversation, and
                    whatever the address names opened beside it. Every
                    address is drawn there — the frame reads it rather than
                    a route table, so the conversation it holds survives
                    every navigation, and an address nothing draws comes
                    home to `/chat`. */}
                <ChatWindow />

                {/* What became of the work somebody already had, when
                    they sign in to an organisation (EO-325, ARCHITECTURE.md, "What a person sees
                    first",
                    "Identity"). Beside the window rather than inside a
                    view: it is about the installation and not about a
                    place in it, and a sheet mounted under one view would
                    be unmounted mid-decision by a navigation.

                    Inside `FirstRunGate`, deliberately. A fresh
                    installation has no local projects to be asked
                    about, so the sheet is empty there anyway; putting
                    it outside would only make two welcome screens
                    capable of being on the glass at once. */}
                <KeepOrMoveSheet />
              </FirstRunGate>
            </ItemReferenceProvider>
          </ViewPublisher>
        </HashRouter>
        </AdminAuthorityProvider>
        </ServedSignInGate>
        </InvitationGate>
        </>
        )}
      </QueryClientProvider>
    </ThemeProvider>
  );
}
