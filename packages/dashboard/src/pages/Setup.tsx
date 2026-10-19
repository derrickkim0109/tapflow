import { Navigate, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAuthStatus, queryKeys } from '@/lib/queries'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldError } from '@/components/ui/field-error'
import { FormErrorCount } from '@/components/ui/form-error-count'
import { FieldHint } from '@/components/ui/field-hint'
import { PASSWORD_HINT, PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT, describedBy } from '@/lib/password'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT),
  confirm: z.string(),
}).refine((d) => d.password === d.confirm, {
  message: 'Passwords do not match',
  path: ['confirm'],
})
type FormData = z.infer<typeof schema>

export function Setup() {
  const navigate = useNavigate()
  const { resolvedTheme } = useTheme()
  const defaultLogo = resolvedTheme === 'dark' ? '/logo-dark.svg' : '/logo.svg'

  const { register, handleSubmit, setError, formState: { errors, isSubmitting, submitCount } } = useForm<FormData>({
    shouldFocusError: false, // FormErrorCount focuses, once the field is described (#824)
    resolver: zodResolver(schema),
  })

  // Once per visit, as on Login, and shared with it: the key is the same.
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: queryKeys.authStatus, queryFn: getAuthStatus, staleTime: Infinity })

  async function onSubmit(data: FormData) {
    try {
      const res = await fetch('/api/v1/auth/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email, password: data.password }),
      })
      if (!res.ok) {
        const body = await res.json() as { error?: string }
        setError('root', { message: body.error ?? 'Failed to create account' })
        return
      }
      // The cached answer said "not initialized", and nothing refetches it: without this, Login would
      // read it and send the new admin straight back here.
      queryClient.setQueryData(queryKeys.authStatus, { initialized: true })
      navigate('/login', { replace: true })
    } catch {
      setError('root', { message: 'Network error. Please try again.' })
    }
  }

  if (status.data?.initialized) return <Navigate to="/login" replace />
  // Nothing until the relay answers, or a browser that may not initialize is shown the form first and
  // can start typing into it. A failed check is not pending, so it still reaches the form.
  if (status.isPending) return null
  // Only an explicit no hides the form. A failed check or a relay that does not report it keeps the
  // form, and `auth/init` still refuses on its own.
  const remote = status.data?.canInitialize === false

  return (
    <div className="flex min-h-svh items-center justify-center overflow-hidden p-4">
      <div className="flex flex-col items-center gap-6 w-full max-w-sm">
        <div className="flex items-center gap-2">
          <img src={defaultLogo} alt="tapflow" className="w-6 h-6" />
          <span className="text-base font-semibold tracking-tight">tapflow</span>
        </div>
        <Card level={4} className="w-full">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl tracking-display-md">Set up tapflow</CardTitle>
          </CardHeader>
          <CardContent>
            {remote ? (
              <div className="flex flex-col gap-3">
                <p id="setup-remote-command" className="text-sm text-muted-foreground">
                  The admin account can only be created on the machine running the relay. Run this there, then reload this page:
                </p>
                {/* A field rather than text, so a keyboard user can select it. No copy button: this page
                    is not on localhost, and over plain HTTP the clipboard API is not available. */}
                <Input readOnly value="tapflow admin init" aria-labelledby="setup-remote-command" onFocus={(e) => e.currentTarget.select()} className="font-mono" />
                {/* Not "open it at localhost": through Docker's bridge gateway that is not local either, and
                    the relay-only image has no CLI, so the variables are the only way in there. */}
                <p className="text-sm text-muted-foreground">
                  Running the relay in Docker? Set <code className="text-xs">TAPFLOW_ADMIN_EMAIL</code> and <code className="text-xs">TAPFLOW_ADMIN_PASSWORD</code> on the container and recreate it, e.g. with <code className="text-xs">docker compose up -d</code>. A restart keeps the old environment.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="email">Admin email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="admin@yourteam.com"
                    autoComplete="email"
aria-required="true" aria-invalid={!!errors.email}
aria-describedby={errors.email ? 'email-error' : undefined}
{...register('email')}
                  />
                  <FieldError id="email-error" message={errors.email?.message} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
aria-required="true" aria-invalid={!!errors.password}
aria-describedby={describedBy('password-hint', 'password-error', !!errors.password)}
{...register('password')}
                  />
                  {!errors.password && <FieldHint id="password-hint">{PASSWORD_HINT}</FieldHint>}
                  <FieldError id="password-error" message={errors.password?.message} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
aria-required="true" aria-invalid={!!errors.confirm}
aria-describedby={errors.confirm ? 'confirm-error' : undefined}
{...register('confirm')}
                  />
                  <FieldError id="confirm-error" message={errors.confirm?.message} />
                </div>
                <FieldError assertive id="setup-error" message={errors.root?.message} />
                <Button type="submit" size="lg" disabled={isSubmitting} className="w-full mt-1">
                  {isSubmitting ? 'Creating account…' : 'Create admin account'}
                </Button>
                <FormErrorCount errors={errors} submitCount={submitCount} />
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
